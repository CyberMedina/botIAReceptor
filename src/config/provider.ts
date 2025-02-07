import { BaileysProvider } from '@builderbot/provider-baileys'
import { createProvider } from '@builderbot/bot'

export const createCustomProvider = () => {
    const provider = createProvider(BaileysProvider, {
        // Aquí van tus configuraciones actuales
    })

    // Accedemos al socket interno donde están los métodos
    const socket = (provider as any).socket

    if (socket) {
        // Sobreescribimos el método handleCall en el socket
        socket.handleCall = async (node: any) => {
            const { attrs } = node
            const [infoChild] = node.children || []
            const callId = infoChild?.attrs?.['call-id']
            const from = infoChild?.attrs?.from || infoChild?.attrs?.['call-creator']
            const status = infoChild?.attrs?.['type'] || 'unknown'

            const call = {
                chatId: attrs.from,
                from,
                id: callId,
                date: new Date(+attrs.t * 1000),
                offline: !!attrs.offline,
                status,
            }

            // Solo emitimos el evento y enviamos ACK
            socket.ev.emit('call', [call])
            await socket.sendMessageAck(node)
        }

        // Sobreescribimos el método rejectCall en el socket
        socket.rejectCall = async (callId: string, callFrom: string) => {
            console.log('Llamada entrante recibida:', { callId, callFrom })
        }
    }

    return provider
} 