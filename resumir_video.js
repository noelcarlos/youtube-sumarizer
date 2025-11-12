// ==========================================================
// IMPORTACIÓN DE LIBRERÍAS
// ==========================================================
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from '@danielxceron/youtube-transcript';
// Módulos nativos para archivos y URLs
import * as fs from 'fs/promises'; 
import { URL } from 'url';
// Módulo para el envío de correos
import * as nodemailer from 'nodemailer';
import { marked } from 'marked'; // <- NUEVA IMPORTACIÓN PARA CONVERSIÓN DE MD A HTML

// **********************************************************
// Clave de API Hardcoded (NO RECOMENDADO en producción)
// **********************************************************
const GEMINI_API_KEY = "AIzaSyBapbpwI8zBdCbw_OzeS7Fwikzx7l82Cgw";
// Inicializa el cliente de Gemini.
const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});


// --- CONFIGURACIÓN DE EMAIL (DEBE SER PERSONALIZADA) ---
const EMAIL_USER = "david.rey.1040@gmail.com";        // 📧 Tu dirección de Gmail
const EMAIL_PASS = "bnbh nvik drov sgmk";      // 🔑 Tu contraseña de aplicación (App Password)
//const EMAIL_TO = "noel.carlos@gmail.com";          // 📬 Correo del destinatario
const EMAIL_TO = "noel.carlos@gmail.com"; 
const EMAIL_BCC = null; //"kl2053258@gmail.com";
// -----------------------------------------------------

/**
 * Función para extraer el ID del video de YouTube de la URL.
 */
function extractVideoId(urlString) {
    try {
        const url = new URL(urlString);
        if (url.hostname.includes('youtube.com') && url.searchParams.has('v')) {
            return url.searchParams.get('v');
        }
        if (url.hostname.includes('youtu.be') && url.pathname.length > 1) {
            return url.pathname.substring(1);
        }
    } catch (e) {
        return null;
    }
    return null;
}

/**
 * Función para obtener la URL de la portada (thumbnail) de YouTube.
 * @param {string} videoId El ID del video de YouTube.
 * @returns {string} La URL de la imagen de portada de alta resolución.
 */
function getThumbnailUrl(videoId) {
    // URL predecible de la miniatura de alta calidad
    return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * Envía el resumen por correo electrónico en formato HTML (cuerpo del correo).
 * @param {string} videoId ID del video.
 * @param {string} subject Título del correo.
 * @param {string} finalContent Contenido completo generado por Gemini (MD).
 */
async function sendEmail(videoId, subject, finalContent) {
    console.log('\n-> 4. Iniciando envío de correo electrónico...');
    
    // --- CONVERSIÓN DE MARKDOWN A HTML ---
    const summaryHtml = marked(finalContent);
    const thumbnailUrl = getThumbnailUrl(videoId);
    // ------------------------------------

    // Configuración del transporte (ejemplo para Gmail)
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS,
        },
    });

    // Cuerpo del mensaje en HTML
    const mailBodyHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
            <h1 style="color: #4CAF50;">Noel ha generado este resumen para ti</h1>
            <p><strong>Video:</strong> ${subject}</p>
            <p><strong>URL:</strong> <a href="https://www.youtube.com/watch?v=${videoId}">https://www.youtube.com/watch?v=${videoId}</a></p>
            
            <h3 style="border-bottom: 1px solid #eee; padding-bottom: 10px;">Portada del Video</h3>
            <img src="${thumbnailUrl}" alt="Portada del video de YouTube" style="width: 100%; height: auto; display: block; margin-bottom: 20px;">

            <h3 style="border-bottom: 1px solid #eee; padding-bottom: 10px;">Resumen Completo</h3>
            
            <div style="font-size: 16px;">
                ${summaryHtml}
            </div>
            
            <p style="margin-top: 30px; font-size: 16px; color: #999;">---<br>Este correo fue generado automáticamente por un script que ha hecho Noel en Node.js con ayuda de Gemini AI.</p>
        </div>
    `;

    const mailOptions = {
        from: EMAIL_USER,
        to: EMAIL_TO,
        subject: `[RESUMEN AI] ${subject}`,
        html: mailBodyHtml, // <- Enviamos el cuerpo en formato HTML
        bcc: EMAIL_BCC,
        // No hay attachments
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Correo electrónico con resumen HTML enviado a ${EMAIL_TO}. Asunto: ${mailOptions.subject}`);
    } catch (error) {
        console.error(`\n❌ ERROR al enviar el correo. Revisa tus credenciales. Mensaje:`, error.message);
    }
}

/**
 * 1. Extrae el transcript de un video de YouTube.
 * 2. Lo envía a la IA de Gemini para que lo resuma y extraiga el título.
 * 3. Guarda el resumen y lo envía por email.
 * * @param {string} youtubeUrl La URL del video de YouTube.
 */
async function resumirVideo(youtubeUrl) {
    
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
        console.error(`\n❌ ERROR: No se pudo extraer el ID del video de la URL: ${youtubeUrl}. Asegúrate de que el formato es correcto.`);
        return;
    }
    const outputFileName = `${videoId}.md`;

    console.log(`\n==============================================`);
    console.log(`   Procesando URL: ${youtubeUrl}`);
    console.log(`   ID del Video: ${videoId}`);
    console.log(`==============================================`);


    // --- PASO 1: EXTRAER EL TRANSCRIPT ---
    // ... (El código de extracción de transcripción permanece igual) ...
    let transcriptText = '';
    try {
        console.log('-> 1. Intentando obtener la transcripción del video...');
        
        const transcriptArray = await YoutubeTranscript.fetchTranscript(youtubeUrl);
        transcriptText = transcriptArray.map(item => item.text).join(' ');

        if (transcriptText.length < 50) {
            console.error('\n❌ ERROR: La transcripción obtenida es muy corta o no se encontró. El video podría no tener subtítulos disponibles o el idioma no está soportado.');
            return;
        }

        console.log(`✅ Transcripción obtenida exitosamente. Longitud: ${transcriptText.length} caracteres.`);

    } catch (error) {
        console.error('\n❌ ERROR al extraer la transcripción. Asegúrate de que la URL es válida y el video tiene subtítulos.', error.message);
        return;
    }


    // --- PASO 2: GENERAR EL RESUMEN CON GEMINI ---
    let summary = '';
    let videoTitle = 'Resumen de Video de YouTube'; 
    let finalContent = '';

    try {
        console.log('\n-> 2. Generando resumen con la IA de Gemini...');

        // PROMPT MODIFICADO: Pedimos el título y el idioma en las primeras líneas.
        const prompt = `Por favor, analiza y resume el siguiente transcript de un video de YouTube.
            En la primera línea del resultado, proporciona únicamente el título más probable del video basado en el contenido del transcript.
            En la segunda línea separada, indica solo el idioma original detectado del transcript (ej: "Idioma Original: Español" o "Original Language: English").

            **Muy importante:** A partir de la tercera línea, responde únicamente en el idioma detectado del transcript. Si el transcript está en inglés, responde en inglés; si está en español, responde en español. No traduzcas ni cambies el idioma, aunque el prompt esté en español.

            Luego, genera un resumen exhaustivo, destacando puntos clave, argumentos principales y conclusiones, usando formato Markdown (encabezados, listas, negritas) para facilitar la lectura.

            TRANSCRIPT:
            ---
            ${transcriptText}
            ---`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: prompt,
        });

        finalContent = response.text; // Contenido completo: Título + Idioma + Resumen

        // Procesamos el contenido para extraer el título (primera línea)
        const lines = finalContent.split('\n');
        if (lines.length > 0) {
            videoTitle = lines[0].trim(); // Título para el email
            summary = lines.slice(2).join('\n').trim(); // Contenido del resumen después del título y el idioma
        }
        
        // --- PASO 3: MOSTRAR POR CONSOLA ---
        console.log('\n==============================================');
        console.log('               RESUMEN GENERADO (Consola)     ');
        console.log('==============================================');
        console.log(finalContent); // Mostramos el contenido completo (título, idioma, resumen)
        console.log('==============================================');

    } catch (error) {
        console.error('\n❌ ERROR al comunicarse con la API de Gemini. Mensaje:', error.message);
        return;
    }
    
    /* --- PASO 4: GUARDAR EN ARCHIVO MD ---
    if (finalContent) {
        try {
            await fs.writeFile(outputFileName, finalContent);
            console.log(`\n✅ Resumen guardado exitosamente en: ${outputFileName}`);
        } catch (error) {
            console.error(`\n❌ ERROR al guardar el archivo ${outputFileName}:`, error.message);
        }
    }*/

    // --- PASO 5: ENVIAR EMAIL ---
    if (finalContent) {
        await sendEmail(videoId, videoTitle, finalContent);
    }
}


// ==========================================================
// LÓGICA DE EJECUCIÓN CON ARGUMENTOS DE LÍNEA DE COMANDO
// ==========================================================

const videoUrl = process.argv[2];

if (!videoUrl) {
    console.error(`
🚨 ERROR: URL de YouTube no proporcionada.
Uso correcto: node resumir_video.js <URL_DE_YOUTUBE>

Ejemplo:
node resumir_video.js "https://www.youtube.com/watch?v=kYJv139D5d8"
`);
} else {
    resumirVideo(videoUrl);
}
