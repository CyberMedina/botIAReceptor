import { join } from 'path'
import { createBot, createFlow, addKeyword, utils, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { image2text } from './gemini'
import { createCustomProvider } from './config/provider'
import "dotenv/config";
import { readFileSync } from 'fs';
import { Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { unlink } from 'fs/promises';

const PORT = process.env.PORT ?? 3007

const welcomeFlow = addKeyword<BaileysProvider, Database>(['_♣_'])
    .addAnswer(`🙌 Hello welcome to this *Chatbot*`)

        const imageFlow = addKeyword(EVENTS.MEDIA)
        .addAction(async (ctx, ctxFn) => {
            console.log("Recibí una imagen")
            let localPath: string | undefined;
            
            try {
                // Verificar el número telefónico
                const phoneNumber = ctx.from
                const checkNumberResponse = await fetch(process.env.URL_API_FLASK + '/checkNumber', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phone: phoneNumber })
                });
                
                const data = await checkNumberResponse.json();
                
                if (!data.found) {
                    console.log('Número no encontrado:');
                    return;
                }
                
                // Guardar la imagen localmente
                localPath = await ctxFn.provider.saveFile(ctx, { path: './assets' })
                
                // Implementación de reintentos para el análisis de imagen
                const MAX_INTENTOS = 5;
                let intento = 1;
                let resultJSON;
                
                while (intento <= MAX_INTENTOS) {
                    try {
                        const prompt = `Clasifica documentos de transacciones como recibos, comprobantes de pago, transferencias, y retiros sin tarjeta. Acepta únicamente transacciones válidas con valores mayores a 0. Si el monto está disponible, inclúyelo en el JSON. Si se detecta que es un 'retiro sin tarjeta', incluye también "retiro_sin_tarjeta": true en la respuesta. Devuelve exclusivamente una respuesta en formato JSON:

                        Para transacciones válidas: {recibo: true, monto: valor, retiro_sin_tarjeta: true/false}.
                        Para transacciones inválidas: {recibo: false}`;
                        
                        const response = await image2text(prompt, localPath)
                        
                        // Limpiar la respuesta antes de parsear
                        const cleanResponse = response
                            .replace(/```json\n/, '')
                            .replace(/```/, '')
                            .trim();
                        
                        resultJSON = JSON.parse(cleanResponse);
                        break; // Si llegamos aquí, el análisis fue exitoso
                        
                    } catch (error) {
                        console.log(`Intento ${intento} fallido:`, error.message);
                        
                        if (intento === MAX_INTENTOS) {
                            // Si fallaron todos los intentos, enviar mensaje a Pepe
                            const testNumber = process.env.NUMBER_PEPE;
                            await ctxFn.provider.sendMessage(
                                testNumber,
                                `❌ Error: No se pudo analizar la imagen después de 5 intentos\n\nNúmero del cliente: ${phoneNumber}`,
                                {}
                            );
                            throw new Error("Error al procesar imagen después de 5 intentos");
                        }
                        
                        // Esperar 2 segundos antes del siguiente intento
                        await new Promise(resolve => setTimeout(resolve, 20000));
                        intento++;
                    }
                }

                if (!resultJSON.recibo) {
                    console.log('Recibo inválido');
                    return;
                }

                // Si es un recibo válido, proceder con el upload
                const formData = new FormData();
                const imageBuffer = await readFileSync(localPath);
                const imageBlob = new Blob([imageBuffer]);
                formData.append('imagen', imageBlob, 'image.jpg');
                formData.append('numero', phoneNumber);
                formData.append('id_cliente', data.id_cliente.toString());
                formData.append('resultado_gemini', JSON.stringify(resultJSON));

                const uploadResponse = await fetch(process.env.URL_API_FLASK + '/upload', {
                    method: 'POST',
                    body: formData, 
                });

                if (!uploadResponse.ok) {
                    throw new Error('Error al subir la imagen');
                }

                const responseData = await uploadResponse.json();

                // Enviar mensaje de prueba con datos del cliente
                const testNumber = process.env.NUMBER_PEPE
                const whatsappMessage = `🔔 *Nuevo Recibo Recibido*\n\n` +
                    `👤 Cliente: ${responseData.Nombre_cliente} ${responseData.Apellido_cliente}\n` +
                    `💰 Monto Sugerido: C$${responseData.monto_sugerido}\n` +
                    `📝 Observación: ${responseData.observacion_sugerida}\n\n` +
                    `🔍 Ver detalles: ${responseData.url_chat}`;

                await ctxFn.provider.sendMessage(testNumber, whatsappMessage, {})

                // Notificar a través de Voice Monkey con datos del cliente
                try {
                    const voiceMonkeyMessage = `Nuevo recibo de ${responseData.Nombre_cliente} ${responseData.Apellido_cliente} ` +
                        `por ${responseData.monto_sugerido} córdobas. Es vía ${responseData.observacion_sugerida}`;

                    const voiceMonkeyResponse = await fetch(
                        'https://api-v2.voicemonkey.io/announcement?' + new URLSearchParams({
                            token: process.env.VOICE_MONKEY_TOKEN,
                            device: process.env.VOICE_MONKEY_DEVICE,
                            text: voiceMonkeyMessage,
                            chime: 'soundbank://soundlibrary/home/amzn_sfx_doorbell_01',
                            language: 'es-MX',
                            character_display: '¡Nuevo Recibo!'
                        })
                    );

                    if (!voiceMonkeyResponse.ok) {
                        console.error('Error al enviar notificación a Voice Monkey');
                    }
                } catch (error) {
                    console.error('Error con Voice Monkey:', error);
                }

            } catch (error) {
                console.error('Error en el proceso:', error);
            } finally {
                // Limpiar archivo temporal solo si existe
                if (localPath) {
                    try {
                        await unlink(localPath);
                        console.log('Archivo eliminado:', localPath);
                    } catch (unlinkError) {
                        console.error('Error al eliminar el archivo:', unlinkError);
                    }
                }
            }
        })

// Configuración del rate limiter modificada
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // límite de 2 solicitudes por ventana
    handler: (req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Demasiadas solicitudes, por favor intente más tarde' }));
    },
    keyGenerator: (req) => {
        return req.headers['x-forwarded-for']?.toString() || 
               req.socket.remoteAddress || 
               'default-ip';
    }
})

// Middleware de autenticación mejorado
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // Aplicar rate limiting primero
    limiter(req, res, async () => {
        const apiKey = req.headers['x-api-key']
        
        if (!apiKey || apiKey !== process.env.API_KEY) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        
        next()
    })
}

// Middleware para Basic Auth específico para /health
const healthAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.writeHead(401, { 
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Basic realm="Health Check"'
        });
        res.end(JSON.stringify({ error: 'Autenticación requerida' }));
        return;
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');

    if (username !== process.env.HEALTH_USER || password !== process.env.HEALTH_PASSWORD) {
        res.writeHead(401, { 
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Basic realm="Health Check"'
        });
        res.end(JSON.stringify({ error: 'Credenciales inválidas' }));
        return;
    }

    next();
}

const main = async () => {
    const provider = createCustomProvider()
    const database = new Database()
    const flows = createFlow([welcomeFlow, imageFlow])

    const { handleCtx, httpServer } = await createBot({
        flow: flows,
        provider,
        database,
    })

    // Aplicar middleware de autenticación a todas las rutas EXCEPTO /health
    provider.server.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path === '/health') {
            return next();
        }
        authMiddleware(req, res, next);
    });

    provider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    provider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    provider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    provider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    provider.server.get('/health', healthAuthMiddleware, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'OK', 
            timestamp: new Date().toISOString() 
        }));
    })

    httpServer(Number(PORT))
}

main()
