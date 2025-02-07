import { BaileysProvider } from '@builderbot/provider-baileys'
import { createProvider } from '@builderbot/bot'
import { proto } from '@whiskeysockets/baileys'

export const createCustomProvider = () => {
    const provider = createProvider(BaileysProvider, {
        // Aquí van tus configuraciones actuales
    })

    // Accedemos al socket interno donde están los métodos
    const socket = (provider as any).socket

    if (socket) {
        // Sobreescribimos el método handleCall en el socket
        const originalHandleCall = socket.handleCall

        socket.handleCall = async (node: any) => {
            try {
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

                // Registramos la llamada
                console.log('Llamada entrante:', call)
            } catch (error) {
                console.error('Error al manejar la llamada:', error)
                // Si hay error, intentamos usar el manejador original
                if (originalHandleCall) {
                    return originalHandleCall(node)
                }
            }
        }

        // Sobreescribimos el método rejectCall
        socket.rejectCall = async (callId: string, callFrom: string) => {
            console.log('Llamada entrante recibida:', { callId, callFrom })
        }
    }

    return provider
}