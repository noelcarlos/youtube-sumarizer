// ==========================================================
// IMPORTACIÓN DE LIBRERÍAS
// ==========================================================
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from '@danielxceron/youtube-transcript';
// Importamos módulos nativos de Node.js para trabajar con archivos (fs) y URLs (url)
import * as fs from 'fs/promises'; 
import { URL } from 'url';

// **********************************************************
// Clave de API Hardcoded (No recomendado en producción)
// **********************************************************
const GEMINI_API_KEY = "AIzaSyBapbpwI8zBdCbw_OzeS7Fwikzx7l82Cgw";
// Inicializa el cliente de Gemini.
const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});

/**
 * Función para extraer el ID del video de YouTube de la URL.
 * Soporta formatos youtube.com/watch?v=ID y youtu.be/ID.
 * @param {string} urlString La URL del video de YouTube.
 * @returns {string | null} El ID del video o null si no se encuentra.
 */
function extractVideoId(urlString) {
    try {
        const url = new URL(urlString);
        // Caso 1: youtube.com/watch?v=ID
        if (url.hostname.includes('youtube.com') && url.searchParams.has('v')) {
            return url.searchParams.get('v');
        }
        // Caso 2: youtu.be/ID (URLs cortas)
        if (url.hostname.includes('youtu.be') && url.pathname.length > 1) {
            return url.pathname.substring(1);
        }
    } catch (e) {
        // La URL no es válida
        return null;
    }
    return null;
}


/**
 * 1. Extrae el transcript de un video de YouTube.
 * 2. Lo envía a la IA de Gemini para que lo resuma.
 * 3. Muestra el resumen por consola y lo guarda en un archivo MD.
 * * @param {string} youtubeUrl La URL del video de YouTube.
 */
async function resumirVideo(youtubeUrl, language = 'español') {
    
    // --- Lógica para obtener el ID y nombre del archivo ---
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
    try {
        console.log('\n-> 2. Generando resumen con la IA de Gemini...');

        // Pedimos a Gemini que use formato Markdown y incluya información clave
        const prompt = `# Resumen del Video de YouTube\n\n**URL:** ${youtubeUrl}\n\n---\n\nPor favor, analiza y resume el siguiente transcript de un video de YouTube. 
        El resumen debe ser exhaustivo, destacar los puntos clave, argumentos principales y conclusiones, usando formato Markdown (encabezados, listas, negritas) para facilitar la lectura, 
        en la primera linea incluye el idioma original del video, responde en ${language}.

        TRANSCRIPT:
        ---
        ${transcriptText}
        ---`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: prompt,
        });

        summary = response.text;
        
        // --- PASO 3: MOSTRAR POR CONSOLA ---
        console.log('\n==============================================');
        console.log('               RESUMEN GENERADO (Consola)     ');
        console.log('==============================================');
        console.log(summary);
        console.log('==============================================');

    } catch (error) {
        console.error('\n❌ ERROR al comunicarse con la API de Gemini. Mensaje:', error.message);
        return;
    }
    
    // --- PASO 4: GUARDAR EN ARCHIVO MD ---
    try {
        // Aseguramos que el contenido del archivo es el resumen generado por Gemini
        await fs.writeFile("pending/" + outputFileName, `URL: ${youtubeUrl}\n` + summary);
        console.log(`\n✅ Resumen guardado exitosamente en: ${outputFileName}`);
    } catch (error) {
        console.error(`\n❌ ERROR al guardar el archivo ${outputFileName}:`, error.message);
    }
}

// ==========================================================
// LÓGICA DE EJECUCIÓN CON ARGUMENTOS DE LÍNEA DE COMANDO
// ==========================================================

const videoUrl = process.argv[2];
const language = process.argv[3] || 'español';

if (!videoUrl) {
    console.error(`
🚨 ERROR: URL de YouTube no proporcionada.
Uso correcto: node resumir_video.js <URL_DE_YOUTUBE>

Ejemplo:
node resumir_video.js "https://www.youtube.com/watch?v=kYJv139D5d8"
`);
} else {
    resumirVideo(videoUrl, language);
}