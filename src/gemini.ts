import dotenv from 'dotenv';
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from 'path';
import fs from 'fs';

dotenv.config();

// Access your API key as an environment variable.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function chat(prompt: string, text: string) {
    // Choose a model that's appropriate for your use case.

    const formatPrompt = prompt + `\n\nEl input del usuario es el siguiente: ` + text;

    const result = await model.generateContent(formatPrompt);
    const response = result.response;
    const answ = response.text();
    return answ
}

export async function image2text(prompt: string, imagePath: string): Promise<string> {
    // Resuelve la ruta de la imagen y lee el archivo.
    const resolvedPath = path.resolve(imagePath);
    const imageBuffer = fs.readFileSync(resolvedPath);

    // Convierte la imagen a base64 y configura la solicitud.
    const image = {
        inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: "image/png", // Cambia esto según el tipo de imagen, si es diferente.
        },
    };

    // Envía la solicitud a la API.
    const result = await model.generateContent([prompt, image]);

    // Devuelve el texto de la respuesta.
    return result.response.text();
}