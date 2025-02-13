"use strict";
import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import NodeCache from 'node-cache';
import { makeMessagesSocket } from '@builderbot/core-baileys/lib/Socket/messages-send.js';
import { makeMutex } from '@builderbot/core-baileys/lib/Utils/make-mutex.js';
import { extractGroupMetadata } from '@builderbot/core-baileys/lib/Socket/groups.js';
import { 
    proto,
    WAMessageStatus,
    WAMessageStubType,
    BinaryNode,
    decryptMessageNode,
    encodeSignedDeviceIdentity,
    encodeBigEndian,
    getNextPreKeys,
    xmppPreKey,
    xmppSignedPreKey,
    getHistoryMsg,
    unixTimestampSeconds,
    getCallStatusFromNode,
    cleanMessage,
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getAllBinaryNodeChildren,
    jidNormalizedUser,
    isJidGroup,
    isJidStatusBroadcast,
    isJidUser,
    S_WHATSAPP_NET,
    areJidsSameUser,
    jidDecode,
    DEFAULT_CACHE_TTLS,
    KEY_BUNDLE_TYPE,
    MIN_PREKEY_COUNT,
    SocketConfig as BaseSocketConfig,
    WACallEvent as BaseWACallEvent,
    WACallUpdateType
} from '@builderbot/core-baileys';
import Bottleneck from 'bottleneck';

interface CustomSocketConfig extends BaseSocketConfig {
    msgRetryCounterCache?: NodeCache;
    callOfferCache?: NodeCache;
}

interface WACallEvent extends BaseWACallEvent {
    isVideo?: boolean;
    isGroup?: boolean;
    groupJid?: string;
}

const relayLimiter = new Bottleneck({
    maxConcurrent: 1,
});

const FilaUpsert = new Bottleneck({
    maxConcurrent: 1,
});

const FilaBadack = new Bottleneck({
    maxConcurrent: 1,
});

const FilaNotification = new Bottleneck({
    maxConcurrent: 1,
});

const FilaReceipt = new Bottleneck({
    maxConcurrent: 1,
});

export const makeMessagesRecvSocket = (config: CustomSocketConfig) => {
    const { 
        logger, 
        retryRequestDelayMs, 
        maxMsgRetryCount, 
        getMessage, 
        shouldIgnoreJid, 
        forceGroupsPrekeys 
    } = config;

    const sock = makeMessagesSocket(config);
    const { 
        ev, 
        authState, 
        ws, 
        processingMutex, 
        signalRepository, 
        query, 
        upsertMessage, 
        resyncAppState, 
        onUnexpectedError,
        assertSessions, 
        sendNode, 
        relayMessage, 
        sendReceipt, 
        uploadPreKeys, 
        readMessages, 
        fetchProps, 
        sendPresenceUpdate,
        forceReset
    } = sock;

    const retryMutex = makeMutex();

    const msgRetryCache = config.msgRetryCounterCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    });

    const callOfferCache = config.callOfferCache || new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER,
        useClones: false
    });

    const sendActiveReceipts = false;

    const processNodeWithBuffer = async (
        node: BinaryNode,
        identifier: string,
        exec: (node: BinaryNode) => Promise<any>
    ) => {
        ev.buffer();
        await execTask();
        ev.flush();

        function execTask() {
            return exec(node)
                .catch(err => onUnexpectedError(err, identifier));
        }
    };

    const sendMessageAck = async (node: BinaryNode) => {
        const { attrs } = node;
        const ack: BinaryNode = {
            tag: 'ack',
            attrs: {
                id: attrs.id,
                to: attrs.sender_lid || attrs.from,
                class: node.tag
            }
        };

        if (attrs.type) {
            ack.attrs.type = attrs.type;
        }

        if (attrs.participant) {
            ack.attrs.participant = attrs.participant;
        }

        await sendNode(ack);

        if (node.tag === 'message') {
            const hasLowercaseAndDash = /[a-z]/.test(attrs.id) || /-/.test(attrs.id);
            if (hasLowercaseAndDash) {
                logger.error({ recv: { tag: node.tag, attrs } }, 'Eliminando mensaje bugado. Sincronizando y recriando a conexão.');
                await forceReset(true);
            }
        }
    };

    const sendRetryRequest = async (node: BinaryNode, forceIncludeKeys = false) => {
        const msgId = node.attrs.id;
        let retryCount = (msgRetryCache.get(msgId) as number) || 0;
        
        if (retryCount >= maxMsgRetryCount) {
            logger.debug({ retryCount, msgId }, 'reached retry limit, clearing');
            msgRetryCache.del(msgId);
            return;
        }
        
        retryCount += 1;
        msgRetryCache.set(msgId, retryCount);
        
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds;
        const deviceIdentity = encodeSignedDeviceIdentity(account, true);
        
        await authState.keys.transaction(async () => {
            const receipt: BinaryNode = {
                tag: 'receipt',
                attrs: {
                    id: msgId,
                    type: 'retry',
                    to: node.attrs.from
                },
                content: [
                    {
                        tag: 'retry',
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1'
                        }
                    },
                    {
                        tag: 'registration',
                        attrs: {},
                        content: encodeBigEndian(authState.creds.registrationId)
                    }
                ] as BinaryNode[]
            };

            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient;
            }

            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant;
            }

            if (retryCount > 1 || forceIncludeKeys) {
                const { update, preKeys } = await getNextPreKeys(authState, 1);
                const [keyId] = Object.keys(preKeys);
                const key = preKeys[+keyId];
                const content = receipt.content as BinaryNode[];
                content.push({
                    tag: 'keys',
                    attrs: {},
                    content: [
                        { tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
                        { tag: 'identity', attrs: {}, content: identityKey.public },
                        xmppPreKey(key, +keyId),
                        xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                    ]
                });
                ev.emit('creds.update', update);
            }

            await sendNode(receipt);
            logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt');
        });
    };

    const handleCall = async (node: BinaryNode) => {
        // Log completo del nodo de llamada para debug
        logger.info({ fullNode: node }, '📞 Nodo de llamada completo recibido');

        const { attrs } = node;
        const [infoChild] = getAllBinaryNodeChildren(node);
        const callId = infoChild.attrs['call-id'];
        const from = infoChild.attrs.from || infoChild.attrs['call-creator'];
        const status = getCallStatusFromNode(infoChild) as WACallUpdateType;
        
        logger.info({ 
            callId, 
            from, 
            status, 
            attrs: infoChild.attrs 
        }, '📞 Detalles de la llamada');

        // Solo enviamos un ACK básico
        const ack: BinaryNode = {
            tag: 'ack',
            attrs: {
                id: attrs.id,
                to: attrs.from,
                class: 'call'
            }
        };
        await sendNode(ack);

        const call: WACallEvent = {
            chatId: attrs.from,
            from,
            id: callId,
            date: new Date(+attrs.t * 1000),
            offline: !!attrs.offline,
            status,
        };

        // Para llamadas entrantes
        if (status === 'offer') {
            call.isVideo = !!getBinaryNodeChild(infoChild, 'video');
            call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid'];
            call.groupJid = infoChild.attrs['group-jid'];
            
            logger.info({ 
                isVideo: call.isVideo,
                isGroup: call.isGroup,
                callDetails: call 
            }, '📞 Llamada entrante - NO se rechazará');

            callOfferCache.set(call.id, call);
            ev.emit('call', [call]);
            return;
        }

        // Para otros estados de llamada
        const existingCall = callOfferCache.get(call.id) as WACallEvent | undefined;
        if (existingCall) {
            call.isVideo = existingCall.isVideo;
            call.isGroup = existingCall.isGroup;
        }

        if (status === 'reject' || status === 'accept' || status === 'timeout') {
            callOfferCache.del(call.id);
            logger.info({ status, callId }, '📞 Llamada finalizada');
        }

        ev.emit('call', [call]);
    };

    // Redefinimos rejectCall para que no haga absolutamente nada
    const rejectCall = async (callId: string, callFrom: string) => {
        logger.warn({ callId, callFrom }, '❌ Intento de rechazo de llamada BLOQUEADO');
        return; // No hacemos absolutamente nada
    };

    // Limpiamos TODOS los listeners existentes
    ev.removeAllListeners('call');
    ws.removeAllListeners('CB:call');

    // Registramos SOLO nuestro manejador
    ws.on('CB:call', async (node) => {
        logger.info('📞 Evento de llamada recibido');
        await processNodeWithBuffer(node, 'handling call', handleCall);
    });

    // Sobreescribimos cualquier otro manejador que pudiera existir
    sock.ws.on = (event: string, listener: any) => {
        if (event === 'CB:call') {
            logger.warn('❌ Intento de registrar otro manejador de llamadas BLOQUEADO');
            return ws;
        }
        return ws.on(event, listener);
    };

    return {
        ...sock,
        sendMessageAck,
        sendRetryRequest,
        rejectCall
    };
};

// ... [resto del código que copiaste] 