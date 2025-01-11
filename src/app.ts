import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, utils, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { image2text } from './gemini'
import "dotenv/config";
import { readFileSync } from 'fs';
import { Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'

const PORT = process.env.PORT ?? 3007

const welcomeFlow = addKeyword<Provider, Database>(['hi', 'hello', 'hola'])
    .addAnswer(`🙌 Hello welcome to this *Chatbot*`)

        const imageFlow = addKeyword(EVENTS.MEDIA)
        .addAction(async (ctx, ctxFn) => {
            console.log("Recibi una imagen")
            const localPath = await ctxFn.provider.saveFile(ctx, { path: './assets' })
            const prompt = `Clasifica documentos de transacciones como recibos, comprobantes de pago, transferencias, y retiros sin tarjeta. Acepta únicamente transacciones válidas con valores mayores a 0. Si el monto está disponible, inclúyelo en el JSON. Si se detecta que es un 'retiro sin tarjeta', incluye también "retiro_sin_tarjeta": true en la respuesta. Devuelve exclusivamente una respuesta en formato JSON:
    
    Para transacciones válidas: {recibo: true, monto: valor, retiro_sin_tarjeta: true/false}.
    Para transacciones inválidas: {recibo: false}`;
            const response = await image2text(prompt, localPath)
            await ctxFn.flowDynamic(response)
    
            // Modificación en la forma de enviar el mensaje
            const testNumber = process.env.NUMBER_PEPE
            await ctxFn.provider.sendMessage(testNumber, 'Este es un mensaje de prueba', {})
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
    const adapterFlow = createFlow([welcomeFlow, imageFlow])
    const adapterProvider = createProvider(Provider)
    const adapterDB = new Database()
    
    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    // Aplicar middleware de autenticación a todas las rutas EXCEPTO /health
    adapterProvider.server.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path === '/health') {
            return next();
        }
        authMiddleware(req, res, next);
    });

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    adapterProvider.server.get('/health', healthAuthMiddleware, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'OK', 
            timestamp: new Date().toISOString() 
        }));
    })

    httpServer(+PORT)
}

main()
