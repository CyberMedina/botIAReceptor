import { BaileysProvider } from '@builderbot/provider-baileys'
import { createProvider } from '@builderbot/bot'
import { proto } from '@whiskeysockets/baileys'
import { makeMessagesRecvSocket } from '../lib/baileys/messages-recv'

export const createCustomProvider = () => {
    console.log('🔄 Iniciando creación del provider personalizado...');

    const provider = createProvider(BaileysProvider, {
        // Aquí van tus configuraciones actuales
    })

    console.log('✅ Provider base creado, aplicando personalizaciones...');

    // Accedemos al socket interno donde están los métodos
    const socket = (provider as any).socket

    if (socket) {
        console.log('🔧 Configurando socket personalizado...');

        // Eliminamos cualquier manejador existente antes de aplicar nuestras modificaciones
        if (socket.ev) {
            console.log('🧹 Limpiando manejadores existentes...');
            socket.ev.removeAllListeners('call');
        }
        if (socket.ws) {
            socket.ws.removeAllListeners('CB:call');
        }

        // Aplicamos nuestro makeMessagesRecvSocket personalizado
        console.log('🔄 Aplicando socket personalizado...');
        const customSocket = makeMessagesRecvSocket(socket)
        Object.assign(socket, customSocket)

        // Aseguramos que los métodos críticos estén deshabilitados
        socket.handleCall = async (node: any) => {
            console.log('📞 Llamada entrante detectada - NO se rechazará', {
                id: node?.attrs?.id,
                from: node?.attrs?.from
            });
        }

        socket.rejectCall = async (callId: string, callFrom: string) => {
            console.log('❌ Intento de rechazo de llamada BLOQUEADO', { callId, callFrom });
        }

        // Agregamos un listener para debug
        socket.ev.on('call', (calls) => {
            console.log('🔔 Evento de llamada recibido:', JSON.stringify(calls, null, 2));
        });

        console.log('✅ Configuración personalizada completada');
    } else {
        console.warn('⚠️ No se pudo acceder al socket interno');
    }

    return provider
}