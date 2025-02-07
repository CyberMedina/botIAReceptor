import { proto } from '../../WAProto';
import { BinaryNode } from '../WABinary';
import { WACallEvent } from '../Types';

export const monkeyPatchCallHandler = (socket: any) => {
    // Guardamos la referencia original de handleCall
    const originalHandleCall = socket.handleCall;

    // Sobreescribimos handleCall
    socket.handleCall = async (node: BinaryNode) => {
        const { attrs } = node;
        const [infoChild] = getAllBinaryNodeChildren(node);
        const callId = infoChild.attrs['call-id'];
        const from = infoChild.attrs.from || infoChild.attrs['call-creator'];
        const status = getCallStatusFromNode(infoChild);
        
        const call: WACallEvent = {
            chatId: attrs.from,
            from,
            id: callId,
            date: new Date(+attrs.t * 1000),
            offline: !!attrs.offline,
            status,
        };

        if (status === 'offer') {
            call.isVideo = !!getBinaryNodeChild(infoChild, 'video');
            call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid'];
            call.groupJid = infoChild.attrs['group-jid'];
            socket.callOfferCache.set(call.id, call);
        }

        const existingCall = socket.callOfferCache.get(call.id);
        if (existingCall) {
            call.isVideo = existingCall.isVideo;
            call.isGroup = existingCall.isGroup;
        }

        if (status === 'reject' || status === 'accept' || status === 'timeout') {
            socket.callOfferCache.del(call.id);
        }

        // Solo emitimos el evento y enviamos ACK
        socket.ev.emit('call', [call]);
        await socket.sendMessageAck(node);
    };

    // También sobreescribimos rejectCall para que no haga nada
    socket.rejectCall = async (callId: string, callFrom: string) => {
        console.log('Llamada entrante recibida:', { callId, callFrom });
    };

    return socket;
};