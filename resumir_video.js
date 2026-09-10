// ==========================================================
// LIBRARY IMPORTS
// ==========================================================
import { GoogleGenAI } from '@google/genai';
import { OpenAI } from 'openai';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { Innertube } from 'youtubei.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URL } from 'url';
import * as nodemailer from 'nodemailer';
import { marked } from 'marked';
import dotenv from 'dotenv';
import JSON5 from 'json5';
import { setTimeout } from 'timers/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
const execAsync = promisify(exec);

dotenv.config();

// ==========================================================
// CONFIGURATION (CONSTANTES)
// ==========================================================

// --- PIPELINE DIRECTORIES ---
const BASE = './pipeline-data';

export const DIRS = {
    // ======================================================
    // STAGE 0 — PROCESS INPUTS (NUEVO)
    // ======================================================
    PROCESS_INPUTS: {
        INPUT: path.join(BASE, 'process-inputs/input'),    // Archivos fuente (CSV, URLs)
        OUTPUT: path.join(BASE, 'process-inputs/output'),  // JSONs normalizados para Download
        ERROR: path.join(BASE, 'process-inputs/error'),
        ARCHIVE: path.join(BASE, 'process-inputs/archive') // Archivos fuente procesados
    },
    // ======================================================
    // STAGE 1 — DOWNLOAD
    // ======================================================
    DOWNLOAD: {
        INPUT: path.join(BASE, 'download/input'),
        OUTPUT: path.join(BASE, 'download/output'),
        ERROR: path.join(BASE, 'download/error')
    },

    // ======================================================
    // STAGE 2A — SUMMARIZE (resumen corto) y STAGE 2B — REWRITE (reescritura/traduccion
    // completa) — dos etapas hermanas, no una detras de otra: las dos leen el MISMO
    // download/output (DownloadStage las reparte a ambas, ver fanOutOutputs) y pueden usar
    // modelos de IA distintos, corriendo en paralelo de verdad porque ninguna espera a la otra.
    // InterpretSummary (mas abajo) es la que junta las dos mitades antes de seguir.
    // ======================================================
    SUMMARIZE: {
        INPUT: path.join(BASE, 'summarize/input'),
        OUTPUT: path.join(BASE, 'summarize/output'),
        ERROR: path.join(BASE, 'summarize/error')
    },
    REWRITE: {
        INPUT: path.join(BASE, 'rewrite/input'),
        OUTPUT: path.join(BASE, 'rewrite/output'),
        ERROR: path.join(BASE, 'rewrite/error')
    },

    // ======================================================
    // STAGE 2C — INTERPRET SUMMARY (junta resumen + reescritura)
    // ======================================================
    INTERPRET_SUMMARY: {
        INPUT: path.join(BASE, 'interpret-summary/input'),
        OUTPUT: path.join(BASE, 'interpret-summary/output'),
        ERROR: path.join(BASE, 'interpret-summary/error')
    },

    // ======================================================
    // STAGE 3 — EMAIL
    // ======================================================
    EMAIL: {
        INPUT: path.join(BASE, 'email/input'),
        OUTPUT: path.join(BASE, 'email/output'),
        ERROR: path.join(BASE, 'email/error')
    },

    // ======================================================
    // FINAL / SYSTEM
    // ======================================================
    DONE: path.join(BASE, 'done'),
    EVENTS: path.join(BASE, 'events')
};

const EVENT_LOG = path.join(DIRS.EVENTS, 'events.log');

// --- API KEYS ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // REPLACE THIS
const GEMINI_MODEL = "gemini-2.5-flash-lite";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = "deepseek-chat";

// NVIDIA Cloud is OpenAI-compatible, so it reuses OpenAICompatibleClient as-is.
// Default is Nemotron 3.5 Lightning: 30B total but only ~3B active (A3B), which decodes
// fast enough for the per-chunk rewrite pass. Override with NVIDIA_MODEL in .env —
// "nvidia/nemotron-3-ultra-550b-a55b" for the best quality, or
// "mistralai/mistral-nemotron" for a non-reasoning model with strong Spanish.
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b";
const NVIDIA_TIMEOUT_MS = 10 * 60 * 1000; // 10 min, large cloud models can queue

const LMSTUDIO_API_KEY = process.env.LMSTUDIO_API_KEY;
const LMSTUDIO_BASE_URL = "http://localhost:1234/v1";
const LMSTUDIO_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, local models can be slow on long prompts
// Must match an id the local server actually serves — check with:
//   curl -s localhost:1234/v1/models -H "Authorization: Bearer $LMSTUDIO_API_KEY"
// A name that isn't served comes back as a 400, which is what filled events.log with
// "No models loaded". Avoid the *-coder-* builds here: this pipeline writes prose, not code.
const LMSTUDIO_MODEL_NAME = process.env.LMSTUDIO_MODEL || "Qwen3.6-35B-A3B-oQ4e-mtp";

// --- EMAIL CONFIG ---
// Exportadas para que server.js pueda montar su propio transporter y reenviar un email ya
// generado (boton "Enviar email" del drawer) sin tener que pasar por todo EmailStage, que asume
// que el video esta en email/input, no ya en done/.
// Objeto (no consts sueltas) para que server.js pueda mutar `to`/`bcc` en caliente desde
// Settings sin tocar .env ni reiniciar — user/pass del remitente SI quedan fuera de esto,
// porque son credenciales (contraseña de aplicacion de Gmail) y no algo que deba poder
// escribirse desde la UI.
export const EMAIL_CONFIG = {
    user: "david.rey.1040@gmail.com",
    pass: process.env.EMAIL_PASS,
    to: "noel.carlos@gmail.com",
    bcc: "",
};
// Alias para no romper el resto del fichero de golpe.
export const EMAIL_USER = EMAIL_CONFIG.user;
export const EMAIL_PASS = EMAIL_CONFIG.pass;
const OVERRIDE_LANG = null; //"Español"; // Set to null to auto-detect

/** Dials del map-reduce de SummarizeStage (ver SummarizeStage.runMapReduce). Medido sobre el
 * transcript de referencia YA deduplicado (collapseRollingCaptions): 155.311 chars reales, no
 * los 454.612 sin colapsar. Por debajo de SINGLE_CALL_MAX_CHARS se sigue mandando el transcript
 * entero en una sola llamada (mejor coherencia posible, cero costuras) — map-reduce solo entra
 * para la cola larga, donde una sola llamada exige ventanas de contexto enormes y, medido, algunos
 * modelos degeneran en bucles de repeticion. */
// Valores para una ventana de 64K (ver tabla de Opus en model-performance.md — a otra ventana,
// solo SUMMARIZE_SINGLE_CALL_MAX_CHARS y SUMMARIZE_OUTLINE_THRESHOLD_CHARS cambian: 72k/35k a
// 96K, 80k/40k a 128K+. SUMMARIZE_MAP_CHUNK_CHARS y SUMMARIZE_MAP_OVERLAP_CHARS NO se movieron
// con esa tabla — Opus predijo que agrandar el chunk del map no ayudaria, un barrido real lo
// refuto (ver comentario mas abajo), asi que ese valor viene de la medicion, no de la ventana).
const SUMMARIZE_SINGLE_CALL_MAX_CHARS = 60_000;
// Antes esto era UNA constante compartida (TRANSCRIPT_CHUNK_CHARS) para que Summarize y Rewrite
// trocearan igual. Un barrido real (12k/24k/48k/92k, mismo modelo, mismo documento, servidor
// reiniciado entre cada medida para descartar cache de prefijo) demostro que el chunk optimo de
// Summarize NO es 12.000: 92.000 fue un 42% mas rapido (878s -> 509s), refutando la prediccion de
// que agrandar el chunk nunca ayuda. Pero el 12.000 de Rewrite esta medido para OTRA cosa —
// reescritura fiel 1:1 (el output escala con el input) — y su propio sweep documentado mas abajo
// muestra que a 32.000 YA colapsa en repeticion (4.40x). Los dos optimos divergen de verdad, asi
// que ahora son dos constantes explicitas, no una compartida por coincidencia.
const REWRITE_CHUNK_CHARS = 12_000;
const SUMMARIZE_MAP_CHUNK_CHARS = 92_000;
const SUMMARIZE_MAP_OVERLAP_CHARS = 600;
// Si las notas del map concatenadas superan esto, el reduce plano (una sola llamada con TODAS
// las notas) deja de ser fiable — pasa a un reduce jerarquico por outline (ver
// SummarizeStage.runOutlineReduce). ~30-40k chars de notas equivale a un video de 6+ horas ya
// deduplicado; por debajo, una sola llamada de reduce es mas simple y sin riesgo de costuras.
const SUMMARIZE_OUTLINE_THRESHOLD_CHARS = 30_000;

/** Cuantos chars de transcript entran en la ventana de contexto configurada AHORA MISMO en el
 * modelo local — solo importa para SUMMARIZE_SINGLE_CALL_MAX_CHARS, la unica de las 4 constantes
 * de arriba que de verdad depende de la ventana (MAP_CHUNK_CHARS/MAP_OVERLAP_CHARS estan
 * limitados por el presupuesto de bullets del prompt, no por la ventana; ver la tabla de
 * model-performance.md). LOCAL_CONTEXT_WINDOW_TOKENS en .env tiene que reflejar lo que el
 * usuario tenga puesto en oMLX/LM Studio en ese momento — no hay forma de leerlo en caliente
 * desde aqui, asi que si lo cambia sin actualizar .env, esta comprobacion queda desactualizada
 * (avisa igual con el valor viejo, no es peor que no avisar nada). 3,2 chars/token es
 * conservador (medido: 4,2 en ingles con subtitulos crudos sin deduplicar; 3,2 deja margen para
 * español y para texto ya deduplicado, que es mas denso).
 *
 * Default 64_000 (no 128_000): asumido explicitamente a peticion del usuario mientras no se
 * confirme otra cosa — subir esto sin subir tambien la ventana real configurada en el modelo
 * hace que la comprobacion de mas abajo deje de avisar cuando de verdad haría falta. */
const LOCAL_CONTEXT_WINDOW_TOKENS = Number(process.env.LOCAL_CONTEXT_WINDOW_TOKENS || 64_000);
const CHARS_PER_TOKEN_ESTIMATE = 3.2;
// Reserva para que la respuesta del reduce plano/llamada unica nunca se quede sin sitio: medido,
// un resumen bueno puede llegar a >5.000 tokens de salida (Qwen, video de referencia) — 8.000 de
// margen, mas el overhead fijo del propio prompt de instrucciones (~550 tokens en buildPrompt).
const SUMMARIZE_OUTPUT_RESERVE_TOKENS = 8_000;
const SUMMARIZE_PROMPT_OVERHEAD_TOKENS = 550;

{
    const ceilingChars = Math.floor(
        (LOCAL_CONTEXT_WINDOW_TOKENS * 0.85 - SUMMARIZE_OUTPUT_RESERVE_TOKENS - SUMMARIZE_PROMPT_OVERHEAD_TOKENS)
        * CHARS_PER_TOKEN_ESTIMATE
    );
    if (SUMMARIZE_SINGLE_CALL_MAX_CHARS > ceilingChars) {
        console.warn(
            `⚠️ SUMMARIZE_SINGLE_CALL_MAX_CHARS (${SUMMARIZE_SINGLE_CALL_MAX_CHARS.toLocaleString()} chars) ` +
            `supera lo que cabe con margen en una ventana de ${LOCAL_CONTEXT_WINDOW_TOKENS.toLocaleString()} ` +
            `tokens (~${ceilingChars.toLocaleString()} chars, reservando salida) — un video en ese rango puede ` +
            `agotar la ventana antes de terminar la respuesta. Sube LOCAL_CONTEXT_WINDOW_TOKENS en .env si de ` +
            `verdad tienes esa ventana configurada en el modelo, o baja SUMMARIZE_SINGLE_CALL_MAX_CHARS.`
        );
    }
}

// ==========================================================
// SECTION 1: AI CLIENTS (Dependency Injection)
// ==========================================================

class IModelClient {
    async generateContent(promptContent, signal) { throw new Error("Method 'generateContent' is not implemented."); }
}

/** The ceiling on a completion. Deliberately NOT derived from the prompt size.
 *
 * Sizing it to the expected output is the wrong instinct: a faithful rewrite whose text happens to
 * tokenize worse than expected (accents, numbers, names) gets cut off mid-sentence, and the cap
 * itself becomes the bug it was meant to catch. So it is the highest value the endpoint accepts,
 * and its only job is to be a tripwire — a model that starts looping reports
 * finish_reason 'length' instead of running to the server's own default.
 *
 * 1,000,000 is verified against the local oMLX server (HTTP 200); it clamps to whatever the loaded
 * model's context leaves free, 200k for Nemotron 3.5 Lightning. Cloud endpoints validate this field
 * against a per-model maximum and reject an over-large value, so they send nothing and get their own
 * maximum — better than hardcoding a number per model that goes stale.
 *
 * What actually prevents the degenerate loop is chunkTranscript's chunk size, measured in the
 * comment there. This is just the alarm. */
const LOCAL_MAX_OUTPUT_TOKENS = 1_000_000;

/** A completion that stopped because it ran out of room is INCOMPLETE — half a sentence, or in the
 * degenerate case pure repetition. It used to be logged and then written to disk as a success, so a
 * truncated summary reached the final markdown and the email indistinguishable from a good one.
 * Failing here sends the transcript to the stage's error/ folder instead, where it can be requeued. */
function assertNotTruncated(finishReason, label, chars) {
    if (finishReason !== 'length') return;
    throw new Error(
        `[${label}] response hit the output cap (finish_reason=length) after ${chars.toLocaleString()} ` +
        `chars — the completion is incomplete. Usually means the model started repeating itself: ` +
        `lower the chunk size (chunkTranscript's maxChars) or switch model.`
    );
}

/** Retries a call only when the connection itself broke, never when the server answered.
 *
 * The local server intermittently drops the socket mid-generation, surfacing as `TypeError:
 * terminated` from undici. The OpenAI SDK's own maxRetries does NOT cover it: it retries
 * APIConnectionError, and a bare undici TypeError never gets wrapped as one. Unretried, a single
 * dropped socket discards the whole video — one did, four minutes into a run, on chunk 1 of 5.
 *
 * A 4xx/5xx with a body is a real answer about a real problem (bad model name, bad key, prompt too
 * long) and retrying it just wastes minutes reproducing it, so those propagate immediately. */
function isTransientConnectionError(err) {
    if (err?.status) return false;                       // the server answered; not a transport fault
    const s = `${err?.name} ${err?.code} ${err?.message}`.toLowerCase();
    return /terminated|socket|econnreset|epipe|econnrefused|etimedout|fetch failed|network|closed/.test(s);
}

async function withConnectionRetry(label, attempts, fn) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= attempts || !isTransientConnectionError(err)) throw err;
            console.warn(`   ⚠️ [${label}] conexión caída (${err.message}) — reintento ${attempt}/${attempts - 1}`);
        }
    }
}

/** Mutex minimo: encadena promesas, cada `run()` espera a que termine el anterior antes de
 * ejecutar el suyo. Sin esto, dos etapas (Summarize y Rewrite corren como workers
 * independientes, a proposito, para paralelismo real con backends distintos) que apunten AMBAS
 * al mismo servidor local se pisan mandando dos inferencias a la vez al mismo modelo cargado —
 * visto en la practica: LM Studio/oMLX no reparte esa carga, se atasca o tarda muchisimo mas que
 * si se turnan. Cloud (nvidia/gemini/deepseek) no necesita esto — cada proveedor gestiona su
 * propia concurrencia remota; el problema es especifico de "un solo modelo cargado en una GPU". */
function createMutex() {
    let queue = Promise.resolve();
    return {
        run(fn) {
            const result = queue.then(fn, fn);
            // Si fn() falla, la cola sigue viva igualmente (el .catch de aqui es solo para que el
            // rechazo de ESTE turno no tumbe la cadena para el siguiente en espera).
            queue = result.catch(() => {});
            return result;
        },
    };
}

/** Un solo mutex, a nivel de modulo — todas las instancias de LMStudioClient de este proceso
 * (una por SummarizeStage, otra por RewriteStage, sean o no la misma instancia de aiClient) lo
 * comparten, asi que da igual desde que etapa venga la llamada: nunca hay dos peticiones de
 * verdad en vuelo contra el servidor local al mismo tiempo. */
const localInferenceMutex = createMutex();

/** Interruptor en caliente (server.js lo expone en Settings > Colas) — el mutex es el default
 * seguro porque un modelo grande (30B+) se atasca o tarda mucho mas si dos peticiones compiten
 * por la misma GPU, pero un modelo pequeño puede tener margen de sobra para atender dos a la vez
 * sin degradarse. Se desactiva, no se borra: siempre queda la opcion de volver a encenderlo sin
 * reiniciar nada. */
let localMutexEnabled = true;
export function setLocalMutexEnabled(enabled) {
    localMutexEnabled = enabled;
}

class GeminiClient extends IModelClient {
    constructor(apiKey, modelName) {
        super();
        this.ai = new GoogleGenAI({ apiKey });
        this.modelName = modelName;
    }
    async generateContent(promptContent, signal) {
        // El SDK de Gemini no soporta cancelar una llamada en curso vía AbortSignal (a
        // diferencia del cliente OpenAI-compatible) — cancelar mientras corre en Gemini no
        // interrumpe la petición ya en vuelo, solo evita que se lance la siguiente.
        const response = await this.ai.models.generateContent({
            model: this.modelName, contents: promptContent,
        });
        return { client: "Gemini", model: this.modelName, rawContent: response.text }
    }
}

class OpenAICompatibleClient extends IModelClient {
    constructor(apiKey, baseUrl, modelName, timeoutMs = 10 * 60 * 1000, label = "OpenAI") {
        super();
        // Node's global fetch (undici) has its own 300s headers/body timeout that
        // overrides the OpenAI SDK's `timeout` option. Use a dedicated undici Agent
        // with matching timeouts so slow cloud requests aren't cut short.
        const dispatcher = new UndiciAgent({
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            connectTimeout: timeoutMs,
        });
        const fetchWithDispatcher = (url, options = {}) => undiciFetch(url, { ...options, dispatcher });

        this.ai = new OpenAI({ apiKey, baseURL: baseUrl, timeout: timeoutMs, fetch: fetchWithDispatcher });
        this.modelName = modelName;
        this.label = label;
    }
    async generateContent(promptContent, signal) {
        console.log(`   🤖 [${this.label}] Request → prompt length: ${promptContent.length} chars (timeout: ${Math.round(this.ai.timeout / 1000)}s, max_tokens: provider default)`);

        const startedAt = Date.now();
        let response;
        try {
            response = await withConnectionRetry(this.label, 3, () => this.ai.chat.completions.create({
                model: this.modelName,
                messages: [{ role: "user", content: promptContent }],
                temperature: 0.1,
            }, { signal }));
        } catch (err) {
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            console.error(`   ❌ [${this.label}] API error after ${elapsedSec}s: ${err.message}`);
            if (err.response?.data) console.error(`   ❌ [${this.label}] Response data:`, JSON.stringify(err.response.data));
            throw err;
        }

        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const rawContent = response.choices[0].message.content;

        console.log(`   🤖 [${this.label}] Response ← ${rawContent.length} chars in ${elapsedSec}s, finish_reason: ${response.choices[0].finish_reason}`);
        console.log(`   🤖 [${this.label}] Response preview: ${rawContent.slice(0, 300).replace(/\n/g, ' ')}${rawContent.length > 300 ? '...' : ''}`);
        assertNotTruncated(response.choices[0].finish_reason, this.label, rawContent.length);

        return { client: this.label, model: this.modelName, rawContent: rawContent }
    }
}

class LMStudioClient extends IModelClient {
    constructor(apiKey, baseUrl, modelName, timeoutMs) {
        super();
        // Node's global fetch (undici) has its own 300s headers/body timeout that
        // overrides the OpenAI SDK's `timeout` option. Use a dedicated undici Agent
        // with matching timeouts so long local-model generations aren't cut short.
        const dispatcher = new UndiciAgent({
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            connectTimeout: timeoutMs,
        });
        const fetchWithDispatcher = (url, options = {}) => undiciFetch(url, { ...options, dispatcher });

        this.ai = new OpenAI({ apiKey, baseURL: baseUrl, timeout: timeoutMs, fetch: fetchWithDispatcher });
        this.modelName = modelName;
    }
    async generateContent(promptContent, signal) {
        if (!localMutexEnabled) return this._generateContent(promptContent, signal);
        return localInferenceMutex.run(() => this._generateContent(promptContent, signal));
    }

    async _generateContent(promptContent, signal) {
        console.log(`   🤖 [LMStudio] Request → prompt length: ${promptContent.length} chars (timeout: ${Math.round(this.ai.timeout / 1000)}s, max_tokens: ${LOCAL_MAX_OUTPUT_TOKENS.toLocaleString()})`);

        const startedAt = Date.now();
        let response;
        try {
            response = await withConnectionRetry("LMStudio", 3, () => this.ai.chat.completions.create({
                model: this.modelName,
                messages: [{ role: "user", content: promptContent }],
                temperature: 0,
                max_tokens: LOCAL_MAX_OUTPUT_TOKENS,
            }, { signal }));
        } catch (err) {
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            console.error(`   ❌ [LMStudio] API error after ${elapsedSec}s: ${err.message}`);
            if (err.response?.data) console.error(`   ❌ [LMStudio] Response data:`, JSON.stringify(err.response.data));
            throw err;
        }

        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const content = response.choices[0].message.content;
        if (content == null) {
            // Un modelo "razonador" (p.ej. Nemotron) puede volcar todo en reasoning_content y
            // dejar content en null si se queda sin tokens antes de escribir la respuesta visible
            // — sin este guard, el .replace() de abajo petaba con un TypeError opaco que no decia
            // nada del modelo ni del finish_reason real.
            throw new Error(
                `LM Studio devolvio content=null (finish_reason: ${response.choices[0].finish_reason}) — ` +
                `probablemente se quedo sin max_tokens (${LOCAL_MAX_OUTPUT_TOKENS.toLocaleString()}) pensando ` +
                `antes de escribir la respuesta visible.`
            );
        }
        const rawContent = content.replace(/<think>[\s\S]*?<\/think>\s*/g, ''); // Clean "think" tags

        console.log(`   🤖 [LMStudio] Response ← ${rawContent.length} chars in ${elapsedSec}s, finish_reason: ${response.choices[0].finish_reason}`);
        console.log(`   🤖 [LMStudio] Response preview: ${rawContent.slice(0, 300).replace(/\n/g, ' ')}${rawContent.length > 300 ? '...' : ''}`);
        assertNotTruncated(response.choices[0].finish_reason, "LMStudio", rawContent.length);

        return { client: "LMStudio", model: this.modelName, rawContent: rawContent }
    }
}

/** Fails now, with the provider named, instead of letting the request go out keyless and come
 * back as an opaque 400/401 several minutes into a run. Local servers don't need a real key,
 * so lmstudio is deliberately exempt. */
function requireKey(key, provider, envVar) {
    if (!key) throw new Error(`AI_PROVIDER=${provider} needs ${envVar} set in .env`);
    return key;
}

/** Config por defecto de cada proveedor, derivada de las mismas constantes de .env que usa
 * createAiClient — se exporta para que server.js pueda mostrarla en GET /api/settings sin
 * duplicar aqui los valores por defecto (baseUrl, modelo, etc). Las API keys NO se incluyen. */
export const AI_PROVIDER_DEFAULTS = {
    gemini: { model: GEMINI_MODEL, baseUrl: null, hasKey: Boolean(GEMINI_API_KEY) },
    deepseek: { model: DEEPSEEK_MODEL, baseUrl: DEEPSEEK_BASE_URL, hasKey: Boolean(DEEPSEEK_API_KEY) },
    nvidia: { model: NVIDIA_MODEL, baseUrl: NVIDIA_BASE_URL, hasKey: Boolean(NVIDIA_API_KEY) },
    lmstudio: { model: LMSTUDIO_MODEL_NAME, baseUrl: LMSTUDIO_BASE_URL, hasKey: Boolean(LMSTUDIO_API_KEY) },
};

/** `overrides` deja que Settings (server.js) reconfigure el proveedor en caliente — otro modelo,
 * otra base URL, otra key — sin tener que tocar .env ni reiniciar el proceso. Cualquier campo
 * ausente cae en el mismo valor de .env que ya usaba esta funcion. */
export function createAiClient(provider, overrides = {}) {
    switch (provider) {
        case 'gemini':
            return new GeminiClient(
                requireKey(overrides.apiKey || GEMINI_API_KEY, provider, 'GEMINI_API_KEY'),
                overrides.model || GEMINI_MODEL,
            );
        case 'deepseek':
            return new OpenAICompatibleClient(
                requireKey(overrides.apiKey || DEEPSEEK_API_KEY, provider, 'DEEPSEEK_API_KEY'),
                overrides.baseUrl || DEEPSEEK_BASE_URL,
                overrides.model || DEEPSEEK_MODEL,
                10 * 60 * 1000, "DeepSeek",
            );
        case 'nvidia':
            return new OpenAICompatibleClient(
                requireKey(overrides.apiKey || NVIDIA_API_KEY, provider, 'NVIDIA_API_KEY'),
                overrides.baseUrl || NVIDIA_BASE_URL,
                overrides.model || NVIDIA_MODEL,
                NVIDIA_TIMEOUT_MS, "NVIDIA",
            );
        case 'lmstudio':
            return new LMStudioClient(
                overrides.apiKey || LMSTUDIO_API_KEY,
                overrides.baseUrl || LMSTUDIO_BASE_URL,
                overrides.model || LMSTUDIO_MODEL_NAME,
                LMSTUDIO_TIMEOUT_MS,
            );
        default: throw new Error(`Unknown provider: ${provider}. Valid: gemini, deepseek, nvidia, lmstudio`);
    }
}

/** El catalogo de NVIDIA lista 81 modelos, pero la cuenta de esta API key solo tiene acceso
 * real a 16 — el resto responde 404 "Function not found for account" (no es que esten caidos,
 * es que no estan habilitados para esta cuenta). Se probaron los 81 el 2026-09-04 mandando
 * "crea un hello world en Java" con timeout de 3 min cada uno; de esos 16 que SI contestaron
 * algo, esta lista se recorto a mano a los que sirven para esta tarea (resumir/reescribir texto
 * en prosa) — fuera quedaron los de traduccion (riva-translate), moderacion/content-safety
 * (nemoguard, safety-guard), calculo cientifico (ising-calibration) y generacion de imagenes
 * (diffusiongemma): ninguno de esos escribe un resumen aunque respondan bien a cualquier prompt.
 * `poolside/laguna-xs-2.1` se probo aparte con un resumen real en español (no solo el hello
 * world de la primera pasada) y SI escribe prosa fluida — que Poolside sea conocida por modelos
 * de codigo no significa que este lo sea, habia que probarlo antes de sacarlo, no asumir.
 * `nemotron-3.5-lightning` se queda aunque ahora mismo de timeout/504 (ver conversacion) — es el
 * modelo principal del proyecto, un fallo puntual de NVIDIA no significa que haya que sacarlo. Si
 * NVIDIA habilita mas modelos para esta cuenta mas adelante, hay que volver a probar y revisar
 * esta lista a mano — no hay forma de saber desde la API cuales sirven sin probarlos. */
const NVIDIA_WORKING_MODELS = new Set([
    'meta/llama-3.2-11b-vision-instruct',
    'minimaxai/minimax-m3',
    'moonshotai/kimi-k3',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'poolside/laguna-xs-2.1',
    'openai/gpt-oss-20b',
]);

/** Lista real de modelos que ofrece CADA proveedor, para el combo de Settings — nada
 * hardcodeado, porque un catalogo estatico se queda obsoleto en cuanto el proveedor sube un
 * modelo nuevo (o en LMStudio, en cuanto el usuario carga uno distinto en su propio servidor).
 * `overrides.apiKey`/`overrides.baseUrl` dejan probar una key/URL que el usuario acaba de
 * escribir en el formulario y todavia no ha guardado. */
export async function listModels(provider, overrides = {}) {
    switch (provider) {
        case 'lmstudio': {
            const client = new OpenAI({ apiKey: overrides.apiKey || LMSTUDIO_API_KEY || 'lm-studio', baseURL: overrides.baseUrl || LMSTUDIO_BASE_URL });
            const list = await client.models.list();
            return list.data.map(m => m.id).sort();
        }
        case 'nvidia': {
            const client = new OpenAI({ apiKey: requireKey(overrides.apiKey || NVIDIA_API_KEY, provider, 'NVIDIA_API_KEY'), baseURL: overrides.baseUrl || NVIDIA_BASE_URL });
            const list = await client.models.list();
            return list.data.map(m => m.id).filter(id => NVIDIA_WORKING_MODELS.has(id)).sort();
        }
        case 'deepseek': {
            const client = new OpenAI({ apiKey: requireKey(overrides.apiKey || DEEPSEEK_API_KEY, provider, 'DEEPSEEK_API_KEY'), baseURL: overrides.baseUrl || DEEPSEEK_BASE_URL });
            const list = await client.models.list();
            return list.data.map(m => m.id).sort();
        }
        case 'gemini': {
            const ai = new GoogleGenAI({ apiKey: requireKey(overrides.apiKey || GEMINI_API_KEY, provider, 'GEMINI_API_KEY') });
            const pager = await ai.models.list();
            const ids = [];
            for await (const m of pager) ids.push((m.name || '').replace(/^models\//, ''));
            return ids.filter(Boolean).sort();
        }
        default: throw new Error(`Unknown provider: ${provider}. Valid: gemini, deepseek, nvidia, lmstudio`);
    }
}

export function healAIJson(raw) {
    let clean = raw || "";

    clean = stripMarkdownFences(clean);
    clean = removeJunkBeforeAfterJson(clean);
    clean = normalizeUnicode(clean);
    clean = fixBackslashes(clean);
    clean = fixUnclosedStringAtEnd(clean);
    clean = fixTrailingCommas(clean);
    clean = balanceBrackets(clean);
    clean = ensureStringQuotes(clean);

    return clean.trim();
}

/**
 * Removes ```json .... ``` wrappers
 */
function stripMarkdownFences(str) {
    return str
        .replace(/```json/i, "")
        .replace(/```/g, "")
        .trim();
}

/**
 * Removes text before or after the first and last braces
 */
function removeJunkBeforeAfterJson(str) {
    const first = str.indexOf("{");
    const last = str.lastIndexOf("}");
    if (first === -1 || last === -1) return str;
    return str.slice(first, last + 1);
}

/**
 * Normalizes Unicode that often breaks parsers
 */
function normalizeUnicode(str) {
    return str.normalize("NFC");
}

/**
 * Fixes backslashes NOT followed by valid escapes
 */
function fixBackslashes(str) {
    return str.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

/**
 * Fixes the classic AI bug: missing ending quote before final }
 */
function fixUnclosedStringAtEnd(str) {
    // Case: ...text.}
    if (/[^"]\}$/.test(str)) {
        return str.replace(/\}$/, '"}');
    }
    return str;
}

/**
 * Fix trailing commas (very common in AI output)
 */
function fixTrailingCommas(str) {
    return str
        .replace(/,\s*([}\]])/g, "$1"); // remove commas before } or ]
}

/**
 * Attempts to balance brackets if AI dropped the last one
 */
function balanceBrackets(str) {
    const open = (str.match(/\{/g) || []).length;
    const close = (str.match(/\}/g) || []).length;

    if (open > close) {
        return str + "}".repeat(open - close);
    }
    return str;
}

/**
 * Ensures all object keys have quotes: {title: "x"} → {"title": "x"}
 */
function ensureStringQuotes(str) {
    return str.replace(
        /([,{]\s*)([A-Za-z0-9_]+)(\s*:\s*)/g,
        '$1"$2"$3'
    );
}

// ==========================================================
// SECTION 2: PIPELINE MANAGER
// ==========================================================

export async function initDirs() {
    const mkdirRecursive = async (node) => {
        if (typeof node === 'string') {
            await fs.mkdir(node, { recursive: true });
            return;
        }

        if (typeof node === 'object' && node !== null) {
            for (const value of Object.values(node)) {
                await mkdirRecursive(value);
            }
        }
    };

    await mkdirRecursive(DIRS);
}

export class EventLogger {
    async log(event) {
        const line = JSON.stringify({
            timestamp: new Date().toISOString(),
            ...event
        }) + '\n';

        await fs.appendFile(EVENT_LOG, line);
    }
}

class BaseStage {
    constructor({ name, inputDir, outputDir, errorDir, logger }) {
        this.name = name;
        this.inputDir = inputDir;
        this.outputDir = outputDir;
        this.errorDir = errorDir;
        this.logger = logger;
    }

    async listInputs(filterFn = () => true) {
        const files = await fs.readdir(this.inputDir);
        return files.filter(filterFn);
    }

    async logSuccess(inputPaths = [], outputPaths = []) {
        // 1️⃣ consume TODOS los inputs
        await Promise.all(
            inputPaths.map(p => fs.unlink(p).catch(() => { }))
        );

        await this.logger.log({
            stage: this.name,
            status: 'SUCCESS',
            inputs: inputPaths.map(p => path.basename(p)),
            outputs: outputPaths.map(p => path.basename(p)),
            ts: new Date().toISOString()
        });
    }

    async moveToError(inputPaths = [], err) {
        await fs.mkdir(this.errorDir, { recursive: true });

        await Promise.all(
            inputPaths.map(p => {
                const dest = path.join(this.errorDir, path.basename(p));
                return fs.rename(p, dest).catch(() => { });
            })
        );

        await this.logger.log({
            stage: this.name,
            status: 'ERROR',
            inputs: inputPaths.map(p => path.basename(p)),
            error: err.message,
            ts: new Date().toISOString()
        });
    }
}

// ==========================================================
// STAGE 0 — PROCESS INPUTS (NUEVO)
// ==========================================================
/** Unico sitio que sabe sacar un videoId de una URL de YouTube — estaba duplicado en
 * ProcessInputsStage y DownloadStage, y ninguna de las dos copias entendia /shorts/{id} (solo
 * youtu.be/{id} y ?v={id}): un Short encolado se aceptaba como URL valida pero devolvia
 * videoId=null, y generateDownloadInput lo descartaba mas tarde con un throw que solo se veia en
 * el log del servidor — la API respondia `enqueued: 0` sin decir por que. */
function extractVideoId(url) {
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
        const pathMatch = u.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/);
        if (pathMatch) return pathMatch[2];
        return u.searchParams.get('v');
    } catch {
        return null;
    }
}

export class ProcessInputsStage extends BaseStage {
    constructor(logger) {
        super({
            name: 'process-inputs',
            inputDir: DIRS.PROCESS_INPUTS.INPUT,
            outputDir: DIRS.PROCESS_INPUTS.OUTPUT, // download/input
            errorDir: DIRS.PROCESS_INPUTS.ERROR,
            logger
        });
        this.archiveDir = DIRS.PROCESS_INPUTS.ARCHIVE;
    }

    extractVideoId(url) {
        return extractVideoId(url);
    }

    isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }

    // Procesar una línea de CSV o texto plano
    parseUrlLine(line) {
        const trimmed = line.trim();
        
        // Ignorar líneas vacías y comentarios
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            return null;
        }
        
        // Si es una URL completa
        if (this.isValidUrl(trimmed)) {
            return {
                url: trimmed,
                videoId: this.extractVideoId(trimmed),
                source: 'direct-url'
            };
        }
        
        // Si es solo un ID de video (ej: "abc123")
        if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
            return {
                url: `https://www.youtube.com/watch?v=${trimmed}`,
                videoId: trimmed,
                source: 'video-id'
            };
        }
        
        return null;
    }

    // Procesar archivo CSV o TXT
    async processTextFile(filePath) {
        const fileName = path.basename(filePath);
        console.log(`   📄 Processing text file: ${fileName}`);
        
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const urls = [];
            
            for (const line of lines) {
                const urlData = this.parseUrlLine(line);
                if (urlData) {
                    urls.push({
                        ...urlData,
                        sourceFile: fileName
                    });
                }
            }
            
            console.log(`     Found ${urls.length} valid URLs`);
            return urls;
            
        } catch (error) {
            console.error(`   ❌ Error reading file ${fileName}: ${error.message}`);
            throw error;
        }
    }

    // Procesar archivo JSON (puede ser de error o ya procesado)
    async processJsonFile(filePath) {
        const fileName = path.basename(filePath);
        console.log(`   📋 Processing JSON file: ${fileName}`);
        
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON5.parse(content);
            
            // Si es un archivo de error, extraer la URL original
            if (data.error) {
                if (!data.originalUrl) {
                    console.warn(`   ⚠️ Error JSON without originalUrl: ${fileName}`);
                    return [];
                }
                
                return [{
                    url: data.originalUrl,
                    videoId: data.videoId || this.extractVideoId(data.originalUrl),
                    source: 'error-reprocess',
                    originalError: data.error,
                    errorFile: fileName,
                    retryCount: (data.retryCount || 0) + 1
                }];
            }
            
            // Si ya es un archivo de entrada normalizado
            if (data.url) {
                return [{
                    url: data.url,
                    videoId: data.videoId || this.extractVideoId(data.url),
                    source: 'normalized-input',
                    sourceFile: fileName,
                    metadata: data.metadata || {}
                }];
            }
            
            console.warn(`   ⚠️ Unrecognized JSON format: ${fileName}`);
            return [];
            
        } catch (error) {
            console.error(`   ❌ Error parsing JSON file ${fileName}: ${error.message}`);
            throw error;
        }
    }

    // Archivar archivo procesado
    async archiveInputFile(filePath) {
        try {
            const fileName = path.basename(filePath);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const nameWithoutExt = path.basename(fileName, path.extname(fileName));
            const ext = path.extname(fileName);
            const archivedName = `${nameWithoutExt}_${timestamp}${ext}`;
            
            await fs.rename(filePath, path.join(this.archiveDir, archivedName));
            console.log(`     Archived: ${fileName} -> ${archivedName}`);
            
        } catch (error) {
            console.warn(`   ⚠️ Could not archive file: ${error.message}`);
            // Si falla el archivo, al menos moverlo a error
            await fs.rename(filePath, path.join(this.errorDir, path.basename(filePath)));
        }
    }

    // Generar archivo JSON normalizado para Download
    async generateDownloadInput(urlData, index) {
        const { url, videoId, source, sourceFile, originalError, retryCount, metadata } = urlData;
        
        if (!videoId) {
            throw new Error(`Could not extract videoId from URL: ${url}`);
        }
        
        const downloadInput = {
            url: url,
            videoId: videoId,
            source: source,
            sourceFile: sourceFile || 'cli',
            created: new Date().toISOString(),
            metadata: metadata || {}
        };
        
        // Añadir información de reproceso si es necesario
        if (originalError) {
            downloadInput.originalError = originalError;
            downloadInput.retryCount = retryCount || 1;
            downloadInput.lastErrorDate = new Date().toISOString();
        }
        
        // Nombre del archivo: videoId.json (si ya existe, añadir índice)
        let outputFileName = `${videoId}.json`;
        let outputPath = path.join(this.outputDir, outputFileName);
        
        // Verificar si ya existe
        if (await fs.access(outputPath).then(() => true).catch(() => false)) {
            outputFileName = `${videoId}_${index}.json`;
            outputPath = path.join(this.outputDir, outputFileName);
        }
        
        await fs.writeFile(outputPath, JSON.stringify(downloadInput, null, 2));
        console.log(`     Generated: ${outputFileName}`);
        
        return outputPath;
    }

    // Procesar un archivo de entrada
    async processInputFile(filePath) {
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).toLowerCase();
        
        let urls = [];
        
        try {
            // Determinar tipo de archivo
            if (fileExt === '.csv' || fileExt === '.txt') {
                urls = await this.processTextFile(filePath);
            } else if (fileExt === '.json') {
                urls = await this.processJsonFile(filePath);
            } else {
                console.warn(`   ⚠️ Unsupported file type: ${fileName}`);
                await this.archiveInputFile(filePath);
                return [];
            }
            
            // Generar archivos de salida para cada URL
            const generatedFiles = [];
            for (let i = 0; i < urls.length; i++) {
                try {
                    const outputPath = await this.generateDownloadInput(urls[i], i);
                    generatedFiles.push(outputPath);
                } catch (error) {
                    console.error(`     ❌ Failed to generate input for URL: ${error.message}`);
                }
            }
            
            // Archivar el archivo fuente
            await this.archiveInputFile(filePath);
            
            return generatedFiles;
            
        } catch (error) {
            console.error(`   ❌ Error processing file ${fileName}: ${error.message}`);
            // Mover a error
            await fs.rename(filePath, path.join(this.errorDir, fileName));
            return [];
        }
    }

    // Procesar URLs desde línea de comandos
    async processCliUrls(urls) {
        console.log(`\n🔵 [STAGE 0] Processing ${urls.length} URL(s) from CLI...`);
        
        const generatedFiles = [];
        
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            
            try {
                const urlData = this.parseUrlLine(url);
                if (!urlData) {
                    console.warn(`   ⚠️ Invalid URL: ${url}`);
                    continue;
                }
                
                urlData.source = 'cli';
                const outputPath = await this.generateDownloadInput(urlData, i);
                generatedFiles.push(outputPath);
                
            } catch (error) {
                console.error(`   ❌ Failed to process URL ${url}: ${error.message}`);
            }
        }
        
        return generatedFiles;
    }

    // Método principal para procesar todos los inputs
    async execute(cliUrls = []) {
        console.log(`\n🔵 [STAGE 0] Process Inputs`);
        console.log(`   Input directory: ${this.inputDir}`);
        console.log(`   Input urls: ${cliUrls}`);

        let totalGenerated = 0;
        
        try {
            // 1. Procesar archivos en el directorio de entrada
            const inputFiles = await fs.readdir(this.inputDir);
            
            if (inputFiles.length > 0) {
                console.log(`   Found ${inputFiles.length} input file(s)`);
                
                for (const fileName of inputFiles) {
                    const filePath = path.join(this.inputDir, fileName);
                    const generated = await this.processInputFile(filePath);
                    totalGenerated += generated.length;
                }
            } else {
                console.log('   No input files found in directory');
            }
            
            // 2. Procesar URLs desde línea de comandos
            if (cliUrls.length > 0) {
                const generated = await this.processCliUrls(cliUrls);
                totalGenerated += generated.length;
            } else {
                console.log('   No input files in the command line');
            }
            
            console.log(`\n✅ [STAGE 0] Generated ${totalGenerated} download input file(s)`);
            return totalGenerated;
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('   Input directory does not exist, creating...');
                return 0;
            }
            throw error;
        }
    }
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ==========================================================
// STAGE 1 — DOWNLOAD
// ==========================================================
export class DownloadStage extends BaseStage {
    constructor(logger) {
        super({
            name: 'download',
            inputDir: DIRS.DOWNLOAD.INPUT, // CLI
            outputDir: DIRS.DOWNLOAD.OUTPUT,
            errorDir: DIRS.DOWNLOAD.ERROR,
            logger
        });
    }

    // Inicialización única de la API
    async initYoutube() {
        if (!this.yt) {
            this.yt = await Innertube.create();
        }
    }

    extractVideoId(url) {
        return extractVideoId(url);
    }

    async fetchTranscriptWithFallback(url) {
        const videoId = this.extractVideoId(url);
        console.log(`   🔍 1. ID extracted: ${videoId}`);

        // Step 1: get available tracks to know which languages exist
        console.log(`   🔍 2. Consultando pistas disponibles...`);
        const { tracks: captionTracks } = await this._fetchCaptionTracksFromHtml(videoId);

        if (!captionTracks || captionTracks.length === 0) {
            // Use yt-dlp to give a more specific reason
            try {
                const { stdout } = await execAsync(`yt-dlp --print "%(language)s|%(automatic_captions)j|%(subtitles)j" --skip-download --quiet --no-warnings "${url}"`);
                const [audioLang, autoCapsJson, subsJson] = stdout.trim().split('|');

                let autoCaps = {};
                let subs = {};
                try { autoCaps = JSON.parse(autoCapsJson); } catch {}
                try { subs = JSON.parse(subsJson); } catch {}

                const autoLangs = Object.keys(autoCaps);
                const subLangs = Object.keys(subs).filter(k => k !== 'live_chat');
                const hasLiveChat = 'live_chat' in subs;

                if (autoLangs.length === 0 && subLangs.length === 0) {
                    const audioInfo = audioLang && audioLang !== 'None' ? ` El audio está en '${audioLang}' pero YouTube no generó subtítulos automáticos.` : '';
                    const liveChatInfo = hasLiveChat ? " Solo hay 'live_chat' (chat del stream)." : '';
                    throw new Error(`No hay subtítulos disponibles.${audioInfo}${liveChatInfo}`);
                }
            } catch (err) {
                if (err.message.includes('No hay subtítulos')) throw err;
            }
            throw new Error("No hay subtítulos disponibles.");
        }

        const availableCodes = captionTracks.map(t => t.languageCode);
        console.log(`   📋 Pistas disponibles: ${availableCodes.join(', ')}`);

        // Pick best track: any es variant > any en variant > first available
        const findTrack = (prefix) => captionTracks.find(t => t.languageCode?.startsWith(prefix));
        const targetTrack = findTrack('es') || findTrack('en') || captionTracks[0];
        console.log(`   🎯 Pista seleccionada: ${targetTrack.name} (${targetTrack.languageCode})`);

        // Step 2: use yt-dlp with the exact language code found
        try {
            console.log(`   📥 Descargando con yt-dlp (${targetTrack.languageCode})...`);
            return await this._fetchWithYtDlp(videoId, url, targetTrack.languageCode);
        } catch (err) {
            console.warn(`   ⚠️  yt-dlp falló (${err.message}), intentando URL directa...`);
        }

        // Fallback: direct timedtext URL from HTML scraping
        const baseWithoutFmt = targetTrack.baseUrl.replace(/[&?]fmt=[^&]*/g, '');
        for (const { url: finalUrl, fmt } of [
            { url: baseWithoutFmt + '&fmt=json3', fmt: 'json3' },
            { url: baseWithoutFmt + '&fmt=vtt',   fmt: 'vtt' },
            { url: targetTrack.baseUrl,            fmt: 'raw' },
        ]) {
            const response = await global.fetch(finalUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            if (!response.ok) continue;
            const raw = await response.text();
            if (!raw || raw.length < 30) continue;
            const text = this._parseSubtitleContent(raw, fmt);
            if (text) return { text, languageUsed: targetTrack.name };
        }

        throw new Error("No se pudo descargar el transcript en ningún formato.");
    }

    // Las 3 ramas devuelven texto de "rolling captions" de YouTube: cada linea aparece repetida
    // 2-3 veces mientras se desliza en pantalla, y nada de lo que se limpia aqui arriba (marcas
    // de tiempo, tags, entidades) toca ese texto duplicado — collapseRollingCaptions() es lo que
    // lo colapsa, y al ser idempotente no pasa nada si un formato en concreto no lo necesitaba.
    _parseSubtitleContent(raw, fmt) {
        if (fmt === 'json3') {
            try {
                const json = JSON.parse(raw);
                const text = (json.events || [])
                    .flatMap(e => (e.segs || []).map(s => s.utf8 || ''))
                    .join(' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                return text.length > 50 ? collapseRollingCaptions(text) : null;
            } catch { return null; }
        }
        if (fmt === 'vtt') {
            const text = raw
                .replace(/WEBVTT[\s\S]*?\n\n/, '')
                .replace(/\d{2}:\d{2}:\d{2}.\d{3} --> \d{2}:\d{2}:\d{2}.\d{3}[^\n]*/g, '')
                .replace(/<[^>]*>/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            return text.length > 50 ? collapseRollingCaptions(text) : null;
        }
        // raw XML: <transcript><text ...>content</text></transcript>
        const text = raw
            .replace(/<text[^>]*>/g, '').replace(/<\/text>/g, ' ').replace(/<[^>]*>/g, '')
            .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        return text.length > 50 ? collapseRollingCaptions(text) : null;
    }

    /** vtt va primero, no json3: en produccion YouTube ha devuelto 429 en el endpoint de json3
     * para un video mientras el MISMO video, mismo idioma, con vtt funcionaba sin problema
     * (visto con VFxGYDx38OU) — parece throttling especifico de ese formato, no del video ni de
     * la IP. En vez de apostar a un solo formato, se prueban varios en orden y solo se rinde si
     * todos fallan; usa el mismo _parseSubtitleContent que ya sabia leer vtt/json3/raw para el
     * fallback de mas abajo, en vez de duplicar el parseo de JSON aqui. */
    async _fetchWithYtDlp(videoId, url, langCode) {
        const tmpDir = os.tmpdir();
        const outTemplate = path.join(tmpDir, `yt-sub-${videoId}`);

        for (const fmt of ['vtt', 'json3', 'srv1']) {
            const filePath = `${outTemplate}.${langCode}.${fmt}`;
            try {
                const cmd = [
                    'yt-dlp',
                    '--skip-download',
                    '--write-auto-subs',
                    '--write-subs',
                    '--sub-langs', langCode,
                    '--sub-format', fmt,
                    '--output', `"${outTemplate}"`,
                    '--quiet',
                    '--no-warnings',
                    `"${url}"`
                ].join(' ');

                await execAsync(cmd);
                const raw = await fs.readFile(filePath, 'utf-8');
                const text = this._parseSubtitleContent(raw, fmt);
                if (text) {
                    console.log(`   ✅ yt-dlp OK (${langCode}, formato ${fmt}), ${text.length} chars`);
                    return { text, languageUsed: langCode };
                }
                console.warn(`   ⚠️  yt-dlp (${fmt}) devolvió un transcript vacío/corto, probando el siguiente formato...`);
            } catch (err) {
                console.warn(`   ⚠️  yt-dlp con formato ${fmt} falló (${err.message.split('\n')[0]}), probando el siguiente...`);
            } finally {
                await fs.unlink(filePath).catch(() => {});
            }
        }

        throw new Error("yt-dlp no pudo bajar el transcript en ningún formato (vtt/json3/srv1).");
    }

    async _fetchCaptionTracksFromHtml(videoId) {
        console.log(`   🔍 Scraping HTML de YouTube para video ${videoId}...`);
        const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const response = await global.fetch(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
            }
        });

        if (!response.ok) {
            throw new Error(`Error obteniendo página de YouTube: ${response.status}`);
        }

        // Collect cookies from the page response to use in subsequent requests
        const rawCookies = response.headers.getSetCookie?.() ?? [];
        const cookies = rawCookies.map(c => c.split(';')[0]).join('; ') || null;

        const html = await response.text();

        // Extract ytInitialPlayerResponse JSON from the page
        const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*var\s|\s*<\/script>)/s);
        if (!match) {
            throw new Error("No se encontró ytInitialPlayerResponse en la página.");
        }

        let playerResponse;
        try {
            playerResponse = JSON.parse(match[1]);
        } catch {
            throw new Error("No se pudo parsear ytInitialPlayerResponse.");
        }

        const rawTracks = playerResponse?.captions
            ?.playerCaptionsTracklistRenderer
            ?.captionTracks;

        if (!rawTracks || rawTracks.length === 0) {
            return { tracks: null, cookies };
        }

        console.log(`   ✅ HTML scraping encontró ${rawTracks.length} pistas`);
        return {
            tracks: rawTracks.map(t => ({
                languageCode: t.languageCode,
                name: t.name?.simpleText || t.languageCode,
                baseUrl: t.baseUrl,
            })),
            cookies,
        };
    }

    async execute(filePath) {
        console.log(`\n🔵 [STAGE 1] Downloading content: ${filePath}`);
        let inputData;

        try {
            // Leer el archivo de entrada generado por Stage 0
            const content = await fs.readFile(filePath, 'utf-8');
            inputData = JSON5.parse(content);
        } catch (error) {
            console.error(`❌ Error reading input file: ${error.message}`, error);
            await this.moveToError([filePath], error);
            return;
        }
        
        const { url, videoId, source, retryCount } = inputData;

        try {
            if (!url || !videoId) {
                throw `❌ Invalid URL: ${url}`;
            }

            // Fetch transcript
            const transcript = await this.fetchTranscriptWithFallback(url);
            //const transcriptArray = await YoutubeTranscript.fetchTranscript(url);
            const transcriptText = transcript.text;

            // Create data object
            const data = {
                videoId: videoId,
                url: url,
                downloadDate: new Date().toISOString(),
                transcript: transcriptText,
                source: source,
                retryCount: retryCount || 0,
                languageFound: transcript.languageUsed
            };

            const outPath = path.join(this.outputDir, `${videoId}.json`);

            // Save to RAW folder
            await fs.writeFile(
                outPath,
                JSON.stringify(data, null, 2)
            );

            // await fs.writeFile(filePath, JSON.stringify(data, null, 2));

            await this.logSuccess([], [outPath]);

            // Eliminar archivo de entrada
            await fs.unlink(filePath);

            // Wait for 2000 milliseconds (2 seconds)
            await setTimeout(1000);

        } catch (error) {
            console.error(`❌ Error downloading: ${error.message}`, error);
            await this.moveToError([filePath], error);
        }
    }
}

function extractVideoIdFromPath(filePath) {
    const base = path.basename(filePath);

    // soporta: videoId.json, videoId.raw.json, videoId.anything.json
    return base.split('.')[0];
}

/** Colapsa repeticiones INMEDIATAS de bloques de 3-20 palabras — el patron exacto que dejan las
 * "rolling captions" automaticas de YouTube (cada linea se repite 2-3 veces seguidas mientras se
 * desliza en pantalla, y el parseo de subtitulos hoy solo borra las marcas de tiempo, no el
 * texto duplicado). Medido sobre un transcript real de 454.612 caracteres: el contenido de
 * verdad es solo 155.311 (0,34x) — el resto es esto. Importa mas alla del ahorro de tokens: un
 * modelo a temperature 0 alimentado con un texto que YA es un bucle de repeticion puede limitarse
 * a continuar el patron (visto en la practica con gemma-4-12B-agentic sobre este mismo video).
 *
 * Idempotente por construccion — pero solo EN EL PUNTO FIJO: una pasada puede dejar una
 * repeticion desalineada por culpa de otra repeticion vecina consumida justo antes (medido en la
 * practica: un ">> Not necessary." repetido 3 veces solo se colapsaba del todo en la segunda
 * pasada). Por eso `collapseRollingCaptions` de mas abajo repite la pasada hasta que el texto ya
 * no cambia (tope de seguridad de intentos) en vez de asumir que una sola pasada basta — asi da
 * igual cuantas veces o en que orden se llame, siempre converge al mismo resultado. */
function collapseRollingCaptionsOnce(text) {
    const words = text.split(/\s+/);
    const out = [];
    const MIN_PERIOD = 3;
    const MAX_PERIOD = 20;
    let i = 0;
    while (i < words.length) {
        let matchedPeriod = 0;
        const maxPeriod = Math.min(MAX_PERIOD, Math.floor((words.length - i) / 2));
        for (let period = maxPeriod; period >= MIN_PERIOD; period--) {
            let isRepeat = true;
            for (let k = 0; k < period; k++) {
                if (words[i + k] !== words[i + period + k]) { isRepeat = false; break; }
            }
            if (isRepeat) { matchedPeriod = period; break; }
        }
        if (matchedPeriod === 0) {
            out.push(words[i]);
            i++;
            continue;
        }
        for (let k = 0; k < matchedPeriod; k++) out.push(words[i + k]);
        i += matchedPeriod;
        // Sigue saltando MIENTRAS el siguiente bloque siga repitiendo el mismo periodo — una
        // rolling caption no siempre se repite exactamente 2 veces, a veces son 3 o mas.
        while (i + matchedPeriod <= words.length) {
            let stillRepeat = true;
            for (let k = 0; k < matchedPeriod; k++) {
                if (words[i - matchedPeriod + k] !== words[i + k]) { stillRepeat = false; break; }
            }
            if (!stillRepeat) break;
            i += matchedPeriod;
        }
    }
    return out.join(' ');
}

export function collapseRollingCaptions(text) {
    if (!text) return text;
    let current = text;
    for (let pass = 0; pass < 5; pass++) {
        const next = collapseRollingCaptionsOnce(current);
        if (next === current) break;
        current = next;
    }
    return current;
}

/** Trocea texto en frases hasta `maxChars`, sin partir nunca a mitad de frase — la particion
 * BASE, sin solape. RewriteStage y el map de SummarizeStage llaman a esta MISMA funcion sobre el
 * MISMO transcript ya deduplicado, pero cada uno con SU PROPIO tamaño de chunk medido por
 * separado (REWRITE_CHUNK_CHARS vs SUMMARIZE_MAP_CHUNK_CHARS — ver el comentario junto a esas dos
 * constantes: los optimos de las dos etapas divergen de verdad, no es el mismo numero por
 * coincidencia). El solape (necesario solo para el map, ver applyOverlap) se aplica DESPUES, como
 * una vista
 * sobre estos chunks — nunca se guarda solapado, porque RewriteStage concatena sus chunks
 * reescritos verbatim en el resultado final: si llevaran solape, ese texto saldria duplicado. */
function chunkBySentences(text, maxChars) {
    const sentences = text
        .replace(/\s+/g, ' ')
        .replace(/([.!?])\s+/g, '$1\n')
        .split('\n');

    const chunks = [];
    let current = '';

    for (const s of sentences) {
        if ((current + s).length > maxChars) {
            chunks.push(current.trim());
            current = s;
        } else {
            current += (current ? ' ' : '') + s;
        }
    }

    if (current.trim()) {
        chunks.push(current.trim());
    }

    return chunks;
}

/** Vista con solape sobre chunks YA troceados (ver chunkBySentences) — cada chunk (salvo el
 * primero) lleva pegada la cola del chunk anterior, para que el modelo no pierda el antecedente
 * de una frase que quedo colgando al cortar ("eso" o "y por eso" al principio de un chunk no
 * tiene a que referirse si el modelo solo ve ESE chunk). Solo tiene sentido para el map de
 * Summarize — sus chunks alimentan notas descartables, no texto que se concatena verbatim. */
function applyOverlap(chunks, overlapChars) {
    if (overlapChars <= 0 || chunks.length < 2) return chunks;

    return chunks.map((chunk, i) => {
        if (i === 0) return chunk;
        const prevTail = chunks[i - 1].slice(-overlapChars);
        // Corta el solape en el primer espacio para no arrancar a mitad de palabra.
        const cleanTail = prevTail.slice(prevTail.indexOf(' ') + 1);
        return cleanTail ? `${cleanTail} ${chunk}` : chunk;
    });
}

/** Base compartida por SummarizeStage y RewriteStage: las dos hacen una sola llamada (o una
 * serie de llamadas, en el caso de RewriteStage) a SU PROPIO aiClient, y las dos necesitan el
 * mismo rastreo de progreso/cancelacion en vivo — currentJob es lo que server.js lee para
 * /api/state y para el boton de cancelar. Se pisa entero (no se acumula) cada vez que execute()
 * arranca un fichero nuevo, y se limpia SIEMPRE al salir (exito, error o cancelacion). */
class AiJobStage extends BaseStage {
    constructor(opts, aiClient) {
        super(opts);
        this.aiClient = aiClient;
        this.currentJob = null;
    }

    startJob(videoId, fileSizeBytes, step) {
        this.currentJob = {
            videoId,
            step,
            currentChunk: 0,
            totalChunks: 0,
            fileSizeBytes,
            startedAt: Date.now(),
            abortController: new AbortController(),
        };
    }

    /** El SDK de OpenAI no pone err.name a "APIUserAbortError" de verdad (se queda en el "Error"
     * por defecto que hereda de la clase base) — la unica forma fiable de saber si esto vino de
     * pulsar "cancelar" es mirar la señal que NOSOTROS controlamos, no adivinar la forma del
     * error. Si esta aborted, es el usuario, no un fallo real. */
    wasCancelled() {
        return this.currentJob?.abortController.signal.aborted ?? false;
    }
}

export class SummarizeStage extends AiJobStage {
    constructor(aiClient, logger) {
        super({
            name: 'Summarize',
            inputDir: DIRS.SUMMARIZE.INPUT,
            outputDir: DIRS.SUMMARIZE.OUTPUT,
            errorDir: DIRS.SUMMARIZE.ERROR,
            logger
        }, aiClient);
        // Overrides para benchmarking (ver model-performance.md) — null en produccion, usa las
        // constantes de arriba. Un arnes de test puede pisar esto para barrer tamaños de chunk
        // sin tocar SUMMARIZE_MAP_CHUNK_CHARS ni el tope de bullets que usa el pipeline real.
        this.mapChunkChars = null;
        this.mapBulletCap = null;
    }

    // Two short scalar fields on their own lines, then the prose as the rest of the message. The
    // summary is Markdown with headings, bullets and quotes, so it cannot live inside a JSON
    // string without flawless escaping. Here the scalars are trivially parseable and the prose
    // needs no parsing at all.
    //
    // Note there is deliberately no "model_used" field. It used to be requested, and the skeleton
    // in this very prompt showed it pre-filled as "deepseek" — which the model dutifully copied,
    // so every summary reported "deepseek" no matter what actually ran. The real model name is
    // already known in code and does not need to round-trip through the model.
    buildPrompt(transcript) {
        return `
            You are an expert analyst. Read the transcript at the end of this message and produce a
            structured summary of it.

            ### OUTPUT FORMAT — follow this EXACTLY
            Line 1: TITLE: followed by the most likely video title, inferred strictly from the transcript.
            Line 2: LANGUAGE: followed by the transcript's original language in English (e.g. Spanish, English, French).
            Line 3: the marker SUMMARY: on a line of its own.
            Everything after that marker: the summary itself, as free-form Markdown.

            Emit nothing before TITLE: and nothing after the summary. No JSON, no code fences, no commentary.

            ### SUMMARY REQUIREMENTS
            - Be exhaustive and strictly grounded in the transcript. Do NOT invent, assume, or add
              outside information, and do NOT draw conclusions the speaker does not state.
            - Cover the key points, main arguments and explicit conclusions.
            - Use Markdown headings, bullet lists and **bold** for readability. Quotes and any
              punctuation you need are fine — this is plain Markdown, not a quoted string.
            - ${OVERRIDE_LANG
                ? `Write in ${OVERRIDE_LANG}.`
                : `Write in the same language as the transcript. Do NOT translate.`}

            ### EXAMPLE SHAPE
            TITLE: The title inferred from the transcript
            LANGUAGE: Spanish
            SUMMARY:
            ## First theme

            - A key point the speaker actually makes.

            TRANSCRIPT:
            ---
            ${transcript}
            ---
            `;
    }

    /** Fase MAP: notas densas de UNA parte, no un resumen — el reduce es el que ve todas las
     * partes juntas y decide como se organiza el resumen final. Sin headings ni conclusiones: si
     * el chunk trae un "## Tema" y el reduce lo copia tal cual, el resultado final "suena a N
     * resumenes pegados" en vez de a un resumen coherente — el sitio correcto para reorganizar
     * por tema es el reduce, no aqui. Tampoco se le pasa el resumen del chunk anterior: mantener
     * ese estado serializaria el map (adios paralelismo), y en modelos locales pequeños el
     * contexto previo tiende a filtrarse tal cual en la salida en vez de usarse como contexto. */
    buildMapPrompt(chunk, index, total, languageHint, bulletCap = 12) {
        return `
            You are taking dense notes on PART ${index} of ${total} of a video transcript. This is
            raw material for a LATER step that will write the final summary — you are not writing
            the summary yourself, and you cannot see the other parts.

            ### OUTPUT FORMAT — follow this EXACTLY, nothing else
            TOPICS: 2-5 short topic tags for this part, separated by " | "
            NOTES:
            - dense bullet points, one factual claim per bullet, at most ${bulletCap} bullets

            ### RULES
            - No headings (no #, ##, etc), no preamble, no closing remarks, no meta-commentary
              like "in this part the speaker discusses...".
            - Do NOT draw conclusions — a single part cannot see the whole video.
            - Keep numbers, names, quotes and technical terms VERBATIM.
            - ${languageHint ? `Write in ${languageHint}.` : `Write in the same language as the transcript below.`}

            TRANSCRIPT PART ${index}/${total}:
            ---
            ${chunk}
            ---
            `.trim();
    }

    /** Fase REDUCE plana: una sola llamada con TODAS las notas del map, en orden cronologico. Se
     * le pide EXPLICITAMENTE reorganizar por tema (no por parte) — las notas son material en
     * crudo, no secciones ya escritas. Mismo formato TITLE/LANGUAGE/SUMMARY que buildPrompt, asi
     * que InterpretSummaryStage.parseSummary no necesita saber si el resumen vino de una llamada
     * o de map-reduce. */
    buildReducePrompt(notesConcatenated, languageHint) {
        return `
            You are an expert analyst. Below are dense notes taken independently on successive
            parts of a video transcript, IN CHRONOLOGICAL ORDER. They are raw material, not
            sections — write ONE coherent summary of the whole video from them.

            ### OUTPUT FORMAT — follow this EXACTLY
            Line 1: TITLE: followed by the most likely video title, inferred strictly from the notes.
            Line 2: LANGUAGE: followed by the notes' original language in English (e.g. Spanish, English, French).
            Line 3: the marker SUMMARY: on a line of its own.
            Everything after that marker: the summary itself, as free-form Markdown.

            Emit nothing before TITLE: and nothing after the summary. No JSON, no code fences, no commentary.

            ### SUMMARY REQUIREMENTS
            - Reorganize by TOPIC, not by chronological part. Never mention "part", "chunk",
              "fragment", or phrases like "the first part of the video".
            - If a topic is revisited later in the video, cover it once and note that it recurs.
            - Merge duplicated points across notes into a single statement.
            - Be exhaustive and strictly grounded in the notes below. Do NOT invent or add outside
              information, and do NOT draw conclusions the speaker does not state.
            - Open with a short framing paragraph and close only with conclusions the speaker
              actually states.
            - Use Markdown headings, bullet lists and **bold**. Aim for roughly 900-1500 words —
              this is meant to be exhaustive, not a short abstract.
            - ${languageHint ? `Write in ${languageHint}.` : `Write in the same language as the notes below.`}

            NOTES (chronological, raw material — not sections):
            ---
            ${notesConcatenated}
            ---
            `.trim();
    }

    /** Fase OUTLINE (solo para el reduce jerarquico, ver runOutlineReduce): input barato (todas
     * las notas), output barato (titulo + una lista de 8-12 secciones TEMATICAS con que numeros
     * de parte alimenta cada una) — la reorganizacion por tema pasa aqui, una sola vez, en vez de
     * que cada llamada de seccion tenga que adivinarla por su cuenta. */
    buildOutlinePrompt(notesConcatenated, totalParts, languageHint) {
        return `
            You are planning a long summary from dense notes taken on successive parts of a video
            transcript, IN CHRONOLOGICAL ORDER. The video is too long to summarize in one pass, so
            this is the planning step: infer the title/language, then group the notes into 8-12
            THEMATIC sections (not chronological parts) that a later step will write one at a time.

            ### OUTPUT FORMAT — follow this EXACTLY
            TITLE: <title inferred from the notes>
            LANGUAGE: <notes' language in English>
            SECTION: <short thematic section title>
            NOTES: <comma-separated part numbers assigned to this section, e.g. 1,2,5>
            SECTION: <next section title>
            NOTES: <part numbers>
            ... (repeat SECTION/NOTES for every section, 8-12 sections total)

            Every part number from 1 to ${totalParts} must be assigned to at least one section. A
            part can be assigned to more than one section if it genuinely covers more than one
            theme. Order the SECTION lines in the order they should appear in the final summary —
            group by theme, this does not have to match chronological order.

            NOTES (chronological, raw material):
            ---
            ${notesConcatenated}
            ---
            `.trim();
    }

    /** Fase SECTION (reduce jerarquico): escribe SOLO el cuerpo de UNA seccion del outline, a
     * partir SOLO de las notas asignadas a esa seccion — nunca todas las notas, para que el coste
     * por llamada no vuelva a crecer con el tamaño del video. prevTitle/nextTitle son para que no
     * se pise con las secciones vecinas, no para que las resuma. */
    buildSectionPrompt(sectionTitle, assignedNotesText, prevTitle, nextTitle) {
        return `
            You are writing ONE section of a long video summary. Other sections cover the rest of
            the video — write ONLY this section's content, as Markdown body text (no heading, the
            caller adds the heading). Do not restate what other sections already cover.

            SECTION TO WRITE: ${sectionTitle}
            ${prevTitle ? `Previous section (already covered elsewhere, do not repeat it): ${prevTitle}` : ''}
            ${nextTitle ? `Next section (covered separately, do not preempt it): ${nextTitle}` : ''}

            ### RULES
            - Output ONLY the body prose/bullets for THIS section — no heading, no preamble, no
              "in this section", no mention of "parts", "chunks" or "notes".
            - Be exhaustive and strictly grounded in the notes below. Do NOT invent anything.
            - Use Markdown bullet lists and **bold** where useful.

            NOTES ASSIGNED TO THIS SECTION:
            ---
            ${assignedNotesText}
            ---
            `.trim();
    }

    parseOutline(raw) {
        const scalar = (field) => {
            const m = raw.match(new RegExp(`^[ \\t>*_]*${field}\\s*:?\\**\\s*:?[ \\t]*(.+?)[ \\t]*$`, 'im'));
            return m ? m[1].replace(/^\**|\**$/g, '').trim() : '';
        };
        const sections = [];
        const sectionRe = /^SECTION:\s*(.+?)\s*$\n^NOTES:\s*([0-9,\s]+)\s*$/gim;
        let m;
        while ((m = sectionRe.exec(raw))) {
            const noteIndices = m[2].split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
            if (noteIndices.length) sections.push({ title: m[1].trim(), noteIndices });
        }
        if (sections.length === 0) {
            throw new Error(
                `Invalid outline output: no SECTION:/NOTES: pairs found (response started with: ` +
                `${raw.trim().slice(0, 120).replace(/\n/g, ' ')})`
            );
        }
        return { title: scalar('TITLE') || 'Untitled', language: scalar('LANGUAGE') || 'Unknown', sections };
    }

    /** Reduce jerarquico: escape hatch cuando las notas concatenadas son demasiadas para un
     * reduce plano de una sola llamada (ver SUMMARIZE_OUTLINE_THRESHOLD_CHARS). Deliberadamente
     * NO es un fold por pares (combinar de 2 en 2): eso vuelve a comprimir resumenes ya
     * comprimidos en cada nivel (perdida de detalle compuesta) y el modelo nunca ve el documento
     * completo de una vez. Aqui el outline SI ve todas las notas (input barato, output
     * pequeño), y cada seccion se escribe con SOLO sus notas asignadas — el coste crece con el
     * NUMERO de secciones, no con la longitud de una sola llamada gigante. */
    async runOutlineReduce(notes, languageHint) {
        const notesConcatenated = notes.map((n, i) => `--- PART ${i + 1}/${notes.length} ---\n${n}`).join('\n\n');
        const outlinePrompt = this.buildOutlinePrompt(notesConcatenated, notes.length, languageHint);
        const outlineRes = await this.aiClient.generateContent(outlinePrompt, this.currentJob.abortController.signal);
        const outline = this.parseOutline(outlineRes.rawContent);

        this.currentJob.totalChunks = this.currentJob.totalChunks + outline.sections.length;

        const sectionBodies = [];
        let lastModel = outlineRes.model, lastClient = outlineRes.client;
        for (let i = 0; i < outline.sections.length; i++) {
            this.currentJob.currentChunk = this.currentJob.currentChunk + 1;
            const section = outline.sections[i];
            let assignedNotesText = section.noteIndices.map(idx => notes[idx - 1]).filter(Boolean).join('\n\n');

            // Nada obliga a que el outline reparta bien: en el peor caso (le asigna TODAS las
            // partes a TODAS las secciones) el coste por seccion vuelve a crecer con el tamaño
            // del video entero, justo lo que el reduce jerarquico existe para evitar. Un clamp
            // por seccion, no por outline completo, porque una seccion legitimamente grande (le
            // tocaron muchas notas porque el tema de verdad ocupa medio video) sigue siendo valida
            // hasta este limite — solo se corta si se sale de rango.
            const maxSectionChars = SUMMARIZE_OUTLINE_THRESHOLD_CHARS / 2;
            if (assignedNotesText.length > maxSectionChars) {
                console.warn(
                    `   ⚠️ Sección ${i + 1}/${outline.sections.length} ("${section.title}"): notas asignadas ` +
                    `(${assignedNotesText.length} chars) superan el límite por sección (${maxSectionChars}) — ` +
                    `el outline puede haber repartido mal, se recorta.`
                );
                assignedNotesText = assignedNotesText.slice(0, maxSectionChars);
            }

            const prevTitle = outline.sections[i - 1]?.title || null;
            const nextTitle = outline.sections[i + 1]?.title || null;
            const prompt = this.buildSectionPrompt(section.title, assignedNotesText, prevTitle, nextTitle);
            const res = await this.aiClient.generateContent(prompt, this.currentJob.abortController.signal);
            lastModel = res.model;
            lastClient = res.client;
            const body = res.rawContent.trim();
            if (!body) throw new Error(`Section ${i + 1}/${outline.sections.length} ("${section.title}"): el modelo devolvió una sección vacía`);
            sectionBodies.push(`## ${section.title}\n\n${body}`);
        }

        const rawContent = `TITLE: ${outline.title}\nLANGUAGE: ${outline.language}\nSUMMARY:\n${sectionBodies.join('\n\n')}`;
        return { rawContent, model: lastModel, client: lastClient };
    }

    /** Fase MAP + REDUCE completa. Solo se llama cuando el transcript deduplicado supera
     * SUMMARIZE_SINGLE_CALL_MAX_CHARS (ver execute) — para la mayoria de videos se sigue usando
     * la llamada unica de siempre, que da la mejor coherencia posible cuando cabe. */
    async runMapReduce(transcript, languageHint) {
        // Misma funcion de troceado que RewriteStage (chunkBySentences), pero con SU PROPIO
        // tamaño (SUMMARIZE_MAP_CHUNK_CHARS, no el de Rewrite) — medido por separado, ver el
        // comentario junto a esas dos constantes. mapChunkChars/mapBulletCap solo se pisan desde
        // un arnes de benchmark (ver constructor); en produccion son null y usan las constantes.
        const chunkChars = this.mapChunkChars || SUMMARIZE_MAP_CHUNK_CHARS;
        const bulletCap = this.mapBulletCap || Math.max(12, Math.round(chunkChars / 1000));
        const chunks = chunkBySentences(transcript, chunkChars);
        const mapInputs = applyOverlap(chunks, SUMMARIZE_MAP_OVERLAP_CHARS);
        this.currentJob.totalChunks = chunks.length + 1; // +1 de margen para la fase de reduce
        this.currentJob.step = 'summary-map';

        const notes = [];
        let lastModel = null, lastClient = null;
        for (let i = 0; i < mapInputs.length; i++) {
            this.currentJob.currentChunk = i + 1;
            const prompt = this.buildMapPrompt(mapInputs[i], i + 1, mapInputs.length, languageHint, bulletCap);

            let res = await this.aiClient.generateContent(prompt, this.currentJob.abortController.signal);
            let note = res.rawContent.trim();

            if (!note) throw new Error(`Map chunk ${i + 1}/${chunks.length}: el modelo devolvió notas vacías`);

            // Guarda deterministas: si el colapso de repeticiones se come mas del 15% del texto,
            // el modelo entro en un bucle de repeticion (visto en la practica con documentos
            // largos) — un reintento suele bastar, porque no es un problema del contenido sino de
            // esa generacion concreta.
            const collapsed = collapseRollingCaptions(note);
            if (collapsed.length < note.length * 0.85) {
                console.warn(`   ⚠️ Map chunk ${i + 1}/${chunks.length}: repeticion detectada en las notas, reintentando...`);
                res = await this.aiClient.generateContent(prompt, this.currentJob.abortController.signal);
                note = res.rawContent.trim();
                if (!note) throw new Error(`Map chunk ${i + 1}/${chunks.length}: el modelo devolvió notas vacías tras reintentar`);
            }

            // Aviso, no error: unas notas largas no rompen el reduce, solo sugieren que el modelo
            // reescribio en vez de anotar — vale la pena saberlo, no vale la pena tirar el chunk.
            if (note.length > chunks[i].length * 0.4) {
                console.warn(
                    `   ⚠️ Map chunk ${i + 1}/${chunks.length}: notas largas (${note.length} chars sobre ` +
                    `${chunks[i].length} del chunk) — puede que el modelo haya reescrito en vez de anotar`
                );
            }

            lastModel = res.model;
            lastClient = res.client;
            notes.push(note);
        }

        this.currentJob.step = 'summary-reduce';
        this.currentJob.currentChunk = chunks.length + 1;

        const notesConcatenated = notes.map((n, i) => `--- PART ${i + 1}/${notes.length} ---\n${n}`).join('\n\n');

        let rawContent, model, client;
        if (notesConcatenated.length <= SUMMARIZE_OUTLINE_THRESHOLD_CHARS) {
            const prompt = this.buildReducePrompt(notesConcatenated, languageHint);
            const res = await this.aiClient.generateContent(prompt, this.currentJob.abortController.signal);
            rawContent = res.rawContent;
            model = res.model;
            client = res.client;
        } else {
            const res = await this.runOutlineReduce(notes, languageHint);
            rawContent = res.rawContent;
            model = res.model;
            client = res.client;
        }

        return { rawContent, model: model || lastModel, client: client || lastClient, mapChunks: chunks.length, mapChunkChars: chunkChars };
    }

    async execute(filePath) {
        const videoId = extractVideoIdFromPath(filePath);
        const fileSizeBytes = await fs.stat(filePath).then(s => s.size).catch(() => 0);
        this.startJob(videoId, fileSizeBytes, 'summary');

        const fileStart = Date.now();
        try {
            console.log(`   Processing: ${filePath}...`);

            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON5.parse(content);

            if (data.videoId && data.videoId !== videoId) {
                console.warn(`⚠️ videoId mismatch: filename=${videoId}, json=${data.videoId}`);
            }

            // Red de seguridad para ficheros ya en disco de antes del fix en
            // _parseSubtitleContent — idempotente, no hace nada si ya viene limpio.
            const transcript = collapseRollingCaptions(data.transcript);
            const languageHint = data.languageFound || null;

            let client, model, rawContent, summaryStrategy, summaryMapChunks, summaryMapChunkChars;

            if (transcript.length <= SUMMARIZE_SINGLE_CALL_MAX_CHARS && !this.mapChunkChars) {
                summaryStrategy = 'single';
                const prompt = this.buildPrompt(transcript);
                ({ client, model, rawContent } = await this.aiClient.generateContent(prompt, this.currentJob.abortController.signal));
            } else {
                summaryStrategy = 'map-reduce';
                const result = await this.runMapReduce(transcript, languageHint);
                client = result.client;
                model = result.model;
                rawContent = result.rawContent;
                summaryMapChunks = result.mapChunks;
                summaryMapChunkChars = result.mapChunkChars;
            }

            // Se guarda TODO lo que trajo download/output (incluido el transcript) para que
            // InterpretSummary tenga de donde tirar despues de juntar las dos mitades — es la
            // misma duplicacion que ya existia antes de separar esta etapa en dos.
            const summaryPart = {
                ...data,
                summaryModel: model,
                summaryClient: client,
                summaryDate: new Date().toISOString(),
                summaryStrategy,
                ...(summaryMapChunks ? { summaryMapChunks, summaryMapChunkChars } : {}),
                rawContent,
            };

            const outPath = path.join(this.outputDir, `${videoId}.summary-part.json`);
            await fs.writeFile(outPath, JSON.stringify(summaryPart, null, 2));
            await this.logSuccess([filePath], [outPath]);

            console.log(`   🏁 ${videoId} (resumen, ${summaryStrategy}) completado en ${Math.round((Date.now() - fileStart) / 1000)}s`);
        } catch (err) {
            const wasCancelled = this.wasCancelled();
            const reported = wasCancelled ? new Error('Cancelado por el usuario') : err;
            console.error(`   ${wasCancelled ? '🛑' : '❌'} ${wasCancelled ? 'Cancelado' : 'Error resumiendo'} ${filePath}: ${err.message}`);
            await this.moveToError([filePath], reported);
        } finally {
            this.currentJob = null;
        }
    }
}

export class RewriteStage extends AiJobStage {
    constructor(aiClient, logger) {
        super({
            name: 'Rewrite',
            inputDir: DIRS.REWRITE.INPUT,
            outputDir: DIRS.REWRITE.OUTPUT,
            errorDir: DIRS.REWRITE.ERROR,
            logger
        }, aiClient);
    }

    /** 12,000 is measured, not guessed. Sweeping this value against a real 49k transcript on
     * Nemotron 3.5 Lightning 30B A3B, asking for the faithful 1:1 rewrite:
     *
     *   chunk    output/input   time   finish
     *    8,000       1.03x       27s   stop
     *   12,000       0.99x       33s   stop   <- best throughput, 362 output chars/s
     *   16,000       0.99x       46s   stop
     *   24,000       0.99x       91s   stop
     *   32,000       4.40x      497s   length  <- collapses into repetition
     *
     * So this is not a "bigger is faster" dial in either direction. Past ~24k the model loses the
     * thread and repeats itself until it hits the output cap; below that, larger chunks slow decode
     * down (58 tok/s at 24k vs 79 at 12k), so fewer-and-bigger chunks finish a transcript SLOWER
     * overall. Re-measure before changing this, and re-measure when changing model — a diferente
     * modelo, diferente tamaño de chunk optimo, esto no es universal.
     *
     * El default es REWRITE_CHUNK_CHARS — antes esta etapa y el map de SummarizeStage compartian
     * una sola constante (TRANSCRIPT_CHUNK_CHARS), pero un barrido real demostro que el chunk
     * optimo de Summarize es 92.000, muy por encima de los 32.000 donde ESTA etapa ya colapsa en
     * repeticion (medido arriba) — los dos optimos divergen de verdad, asi que ahora son
     * constantes separadas y explicitas, no una compartida por coincidencia. */
    chunkTranscript(text, maxChars = REWRITE_CHUNK_CHARS) {
        return chunkBySentences(text, maxChars);
    }

    /** The chunk rewrite asks for Markdown prose and NOTHING else — no JSON wrapper.
     *
     * It used to ask for `{"chunk_index": n, "content": "<12k chars of prose>"}`, which made the
     * model responsible for escaping every quote and newline in a Spanish text full of `**bold**`
     * and dialogue. It could not do it reliably: two of three videos in a single run died on
     * `JSON5: invalid character` / `missing JSON delimiters`, and the prompt had degenerated into
     * begging ("Never use double quotes"). Four separate repair functions downstream still did not
     * save it, because a mid-string unescaped quote is genuinely unrecoverable — you cannot tell
     * where the value was meant to end.
     *
     * With raw prose there is nothing to escape and nothing to parse, so this class of failure is
     * gone by construction. `chunk_index` is not asked for either: the caller already knows the
     * index, and trusting the model to renumber its own chunks was how ordering could silently
     * scramble. */
    buildChunkPrompt(chunk, index, total) {
        const languageRule = OVERRIDE_LANG
            ? `Write the output in ${OVERRIDE_LANG}. Replace the original text entirely — never emit
                the source text alongside the translation, and never write "original (translation)".
                The audience speaks ONLY ${OVERRIDE_LANG}.`
            : `Write in the same language as the transcript. Do NOT translate.`;

        return `
            You are an expert Editor. You are processing PART ${index} of ${total} of a video transcript.

            ### GOAL
            Rewrite the text below as clean, readable Markdown prose.

            ### FIDELITY — THIS IS THE MOST IMPORTANT RULE
            - Output the FULL text. Do NOT shorten, summarize, or omit anything.
            - Do NOT add, interpret, or embellish. Say only what the speaker says.
            - Your output should be roughly the same length as the input.

            ### LANGUAGE
            ${languageRule}

            ### FORMATTING — PARAGRAPH LENGTH IS STRICT
            1. A paragraph is AT MOST 4 sentences. As soon as you reach 4 sentences, or the topic
               shifts, or the speaker changes, end the paragraph with a blank line and start a new one.
               A spoken transcript naturally runs on for pages without a single break — do not carry
               that over. Never write a paragraph longer than about 500 characters.
            2. Use **bold** for key terms and for words the speaker emphasizes.
            3. Fix punctuation and capitalization.

            ### OUTPUT FORMAT
            Return ONLY the rewritten text itself. No JSON, no code fences, no preamble,
            no "Here is the rewritten text", no closing commentary.

            ### INPUT TEXT:
            ${chunk}
        `.trim();
    }

    /** Strips a reasoning model's leftover scaffolding: a ```fence around the whole answer, or a
     * lead-in line like "Here is the rewritten text:". Everything else is kept verbatim — this must
     * never be lossy, the prose it is cleaning IS the deliverable. */
    cleanProse(raw) {
        let out = raw.trim();

        const fenced = out.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n?```$/i);
        if (fenced) out = fenced[1].trim();

        return out.replace(/^(?:here(?:'s| is)[^\n:]*:|sure[^\n:]*:|okay[^\n:]*:)\s*\n+/i, '').trim();
    }

    /** A deterministic backstop for the "max 4 sentences per paragraph" prompt rule.
     *
     * A spoken transcript is one long run-on by nature, and asking nicely was not enough on its
     * own: real runs came back with single paragraphs spanning an entire 12k-char chunk (measured:
     * 12,793 / 11,931 / 11,515 chars — a wall of text ~150 lines tall). Since fidelity requires
     * every word to survive, this only re-inserts blank lines at sentence boundaries; it never
     * drops or rewrites text. Headings, list items, quotes and code fences are left untouched so it
     * can't mangle Markdown structure the model did produce correctly. */
    rewrapLongParagraphs(text, maxChars = 500, maxSentences = 4) {
        return text
            .split(/\n{2,}/)
            .map((para) => {
                const trimmed = para.trim();
                if (!trimmed || trimmed.length <= maxChars) return trimmed;
                if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(trimmed)) return trimmed;

                // Split into sentences WITHOUT risking dropping any text. An earlier version matched
                // sentences with a greedy alternation regex, which requires whitespace-or-end
                // immediately after the terminator — a sentence ending in a closing quote
                // ("...existen.\" Perfecto.") has no such gap, the match failed, and `.match()`
                // silently drops any unmatched stretch of the string along with it.
                //
                // Splitting on a ZERO-WIDTH position instead (lookbehind for the terminator, lookahead
                // for the following whitespace) consumes no characters at all, so `sentences.join('')`
                // always reconstructs `trimmed` exactly — lossless by construction, regardless of what
                // punctuation pattern the transcript throws at it.
                const sentences = trimmed.split(/(?<=[.!?]+["'”’)\]]*)(?=\s)/);
                const groups = [];
                let current = '', count = 0;
                for (const s of sentences) {
                    if (current && (count >= maxSentences || (current + s).length > maxChars)) {
                        groups.push(current.trim());
                        current = s;
                        count = 1;
                    } else {
                        current += s;
                        count++;
                    }
                }
                if (current.trim()) groups.push(current.trim());
                return groups.join('\n\n');
            })
            .join('\n\n');
    }

    async processChunks(chunks) {
        const results = [];
        this.currentJob.totalChunks = chunks.length;

        for (let i = 0; i < chunks.length; i++) {
            const chunkStart = Date.now();
            const input = chunks[i];
            this.currentJob.currentChunk = i + 1;

            console.log(`   ▶️  Chunk ${i + 1}/${chunks.length} (${input.length} chars) — iniciando...`);

            const prompt = this.buildChunkPrompt(input, i + 1, chunks.length);
            const { client, model, rawContent } = await this.aiClient.generateContent(prompt, this.currentJob.abortController.signal);
            this.currentJob.model = model;
            this.currentJob.client = client;
            const content = this.rewrapLongParagraphs(this.cleanProse(rawContent));

            if (!content) {
                throw new Error(`Chunk ${i + 1}/${chunks.length}: model returned an empty rewrite`);
            }

            // A faithful rewrite comes back at ~1x the input; the measured healthy range is
            // 0.99-1.03x. Anything near half means the model summarized instead of rewriting, which
            // is silent data loss — the old code would have shipped it. Warn loudly rather than
            // throw: a partially short chunk is still worth keeping and reviewing.
            const ratio = content.length / input.length;
            if (ratio < 0.6) {
                console.warn(`   ⚠️ Chunk ${i + 1}/${chunks.length} salió corto: ${content.length} chars ` +
                    `sobre ${input.length} (${ratio.toFixed(2)}x) — el modelo puede haber resumido en vez de reescribir`);
            }

            console.log(`   ✅ Chunk ${i + 1}/${chunks.length} completado en ${Math.round((Date.now() - chunkStart) / 1000)}s (${ratio.toFixed(2)}x)`);
            results.push(content);
        }

        return { chunks: results, model: this.currentJob.model, client: this.currentJob.client };
    }

    async buildRawTranscript(rawTranscript) {
        const chunks = this.chunkTranscript(rawTranscript);
        console.log(`   ✂️  Transcript (${rawTranscript.length} chars) split into ${chunks.length} chunk(s): [${chunks.map(c => c.length).join(', ')}]`);
        return this.processChunks(chunks);
    }

    async execute(filePath) {
        const videoId = extractVideoIdFromPath(filePath);
        const fileSizeBytes = await fs.stat(filePath).then(s => s.size).catch(() => 0);
        this.startJob(videoId, fileSizeBytes, 'rewrite');

        const fileStart = Date.now();
        try {
            console.log(`   Processing: ${filePath}...`);

            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON5.parse(content);

            if (data.videoId && data.videoId !== videoId) {
                console.warn(`⚠️ videoId mismatch: filename=${videoId}, json=${data.videoId}`);
            }

            // Red de seguridad para ficheros ya en disco de antes del fix en _parseSubtitleContent
            // — idempotente, no hace nada si el transcript ya viene limpio.
            const transcript = collapseRollingCaptions(data.transcript);
            const { chunks: fullContentChunks, model, client } = await this.buildRawTranscript(transcript) || { chunks: [] };

            // A diferencia de SummarizeStage, esto NO repite todo el download/output — el
            // resumen ya lo hace (ver SummarizeStage), asi que aqui solo va lo que le falta a
            // InterpretSummary para completar la mitad de rewrite.
            const rewritePart = {
                videoId,
                rewriteModel: model,
                rewriteClient: client,
                rewriteDate: new Date().toISOString(),
                fullContentChunks,
            };

            const outPath = path.join(this.outputDir, `${videoId}.rewrite-part.json`);
            await fs.writeFile(outPath, JSON.stringify(rewritePart, null, 2));
            await this.logSuccess([filePath], [outPath]);

            console.log(`   🏁 ${videoId} (reescritura) completado en ${Math.round((Date.now() - fileStart) / 1000)}s`);
        } catch (err) {
            const wasCancelled = this.wasCancelled();
            const reported = wasCancelled ? new Error('Cancelado por el usuario') : err;
            console.error(`   ${wasCancelled ? '🛑' : '❌'} ${wasCancelled ? 'Cancelado' : 'Error reescribiendo'} ${filePath}: ${err.message}`);
            await this.moveToError([filePath], reported);
        } finally {
            this.currentJob = null;
        }
    }
}

/** Reads the TITLE / LANGUAGE / SUMMARY: shape that SummarizeStage.buildPrompt asks for.
 *
 * This replaced a JSON parse guarded by three escalating repair passes (a string-escaping state
 * machine, a "content"-value regex rewrite, and a code-fence stripper). They existed because the
 * summary's Markdown had to survive being quoted inside JSON, and they still lost two of three
 * videos in one run. Here the scalars are two anchored lines and the prose is simply the rest of
 * the message, so nothing about the summary's own punctuation can break parsing.
 *
 * The scalars are tolerant on purpose — leading indentation, optional bold, `**TITLE:**` — but
 * the SUMMARY: marker is required: without it there is no way to tell where prose begins, and
 * guessing would silently fold the title line into the body. Module-level (not a method) so
 * server.js can parse a `.summary-part.json` straight from disk for the "leer ya, aunque
 * Rewrite/Fusion no hayan terminado" preview, without needing an InterpretSummaryStage instance. */
export function parseSummaryOutput(raw) {
    if (!raw || !raw.trim()) throw new Error("Invalid AI output: empty summary response");

    const scalar = (field) => {
        const m = raw.match(new RegExp(`^[ \\t>*_]*${field}\\s*:?\\**\\s*:?[ \\t]*(.+?)[ \\t]*$`, 'im'));
        return m ? m[1].replace(/^\**|\**$/g, '').trim() : '';
    };

    const marker = raw.match(/^[ \t>*_]*SUMMARY\s*:?\**\s*:?[ \t]*$/im);
    if (!marker) {
        throw new Error(
            `Invalid AI output: no SUMMARY: marker found, so the prose body cannot be located ` +
            `(response started with: ${raw.trim().slice(0, 120).replace(/\n/g, ' ')})`
        );
    }

    const body = raw.slice(marker.index + marker[0].length).trim();
    if (!body) throw new Error("Invalid AI output: SUMMARY: marker present but the body is empty");

    return { title: scalar('TITLE'), language: scalar('LANGUAGE'), content: body };
}

export class InterpretSummaryStage extends BaseStage {
    constructor(logger) {
        super({
            name: 'Interpret Summary',
            inputDir: DIRS.INTERPRET_SUMMARY.INPUT,
            outputDir: DIRS.INTERPRET_SUMMARY.OUTPUT,
            errorDir: DIRS.INTERPRET_SUMMARY.ERROR,
            logger
        });
    }

    parseSummary(raw) {
        return parseSummaryOutput(raw);
    }

    /** The chunks arrive as plain Markdown in the order they were generated, so "assembling" is a
     * join. Order comes from the array index, not from a model-reported chunk_index that used to be
     * sorted on — and a chunk can no longer be dropped here, because there is nothing left to parse. */
    assembleFullContent(chunks) {
        return (chunks || [])
            .map(c => (typeof c === 'string' ? c : '').trim())
            .filter(Boolean)
            .join('\n\n');
    }

    /** El fichero que dispara esta etapa es SIEMPRE el .rewrite-part.json (asi lo filtra
     * server.js: solo entra en la lista cuando su hermano .summary-part.json YA existe) — pero
     * hace falta leer los DOS, porque summarize y rewrite corrieron en paralelo, cada uno con su
     * propio modelo, sobre el mismo transcript. */
    async execute(filePath) {
        const videoId = extractVideoIdFromPath(filePath);
        const summaryPartPath = path.join(this.inputDir, `${videoId}.summary-part.json`);
        const rewritePartPath = filePath;

        try {
            console.log(`   Processing: ${filePath}...`);

            const [summaryRaw, rewriteRaw] = await Promise.all([
                fs.readFile(summaryPartPath, 'utf-8'),
                fs.readFile(rewritePartPath, 'utf-8'),
            ]);
            const summaryData = JSON5.parse(summaryRaw);
            const rewriteData = JSON5.parse(rewriteRaw);

            if (summaryData.videoId && summaryData.videoId !== videoId) {
                console.warn(`⚠️ videoId mismatch: filename=${videoId}, json=${summaryData.videoId}`);
            }

            const parsed = this.parseSummary(summaryData.rawContent);
            const fullContent = this.assembleFullContent(rewriteData.fullContentChunks);

            const title = parsed.title || "Untitled Video";

            // The .md used to hold only the short summary, while the email template pulled BOTH
            // summaryBody and fullContent — so the file on disk silently lacked the transcript
            // rewrite that took the bulk of the run's compute. Same document in both places now.
            const transcriptHeading = rewriteData.rewriteSkipped
                ? '## Transcripción original (sin pulir — Reescritura/Traducción omitida)'
                : '## Transcripción completa';
            const markdown = [
                `# ${title}`,
                parsed.content,
                fullContent ? `---\n\n${transcriptHeading}\n\n${fullContent}` : '',
            ].filter(Boolean).join('\n\n');

            // `model`/`client` combinados para lo que ya muestra la UI (una sola insignia por
            // tarjeta) — summaryModel/rewriteModel se guardan aparte para quien quiera el
            // detalle exacto de cual modelo hizo cada mitad. rewriteSkipped (ver skipRewrite en
            // server.js, boton "usar sin pulir") no tiene modelo que combinar — no hubo llamada
            // de IA, es literalmente el transcript crudo — asi que el resumen manda solo.
            const sameModel = summaryData.summaryModel === rewriteData.rewriteModel;
            const model = rewriteData.rewriteSkipped
                ? summaryData.summaryModel
                : (sameModel ? summaryData.summaryModel : `${summaryData.summaryModel} + ${rewriteData.rewriteModel}`);
            const client = rewriteData.rewriteSkipped
                ? summaryData.summaryClient
                : (sameModel ? summaryData.summaryClient : `${summaryData.summaryClient} + ${rewriteData.rewriteClient}`);

            const enrichedData = {
                ...summaryData,
                title,
                language: parsed.language || "Unknown",
                model,
                client,
                summaryModel: summaryData.summaryModel,
                summaryClient: summaryData.summaryClient,
                rewriteModel: rewriteData.rewriteModel,
                rewriteClient: rewriteData.rewriteClient,
                rewriteSkipped: Boolean(rewriteData.rewriteSkipped),
                summaryBody: parsed.content || "",
                fullContent: fullContent,
                markdown,
            };

            // --- outputs ---
            const jsonOut = path.join(this.outputDir, `${videoId}.enriched.json`);
            const mdOut = path.join(this.outputDir, `${videoId}.summary.md`);

            await Promise.all([
                fs.writeFile(jsonOut, JSON.stringify(enrichedData, null, 2)),
                fs.writeFile(mdOut, markdown)
            ]);

            await this.logSuccess([summaryPartPath, rewritePartPath], [jsonOut, mdOut]);

        } catch (err) {
            console.error(`   ❌ Error processing ${filePath}: ${err.message}`, err);
            await this.moveToError([summaryPartPath, rewritePartPath], err);
        }
    }
}

/** Construye el HTML del email — pura, sin enviar ni tocar disco. Extraida de EmailStage.execute
 * para poder generar una vista previa ANTES de que EmailStage exista de verdad (server.js la usa
 * con los datos parciales de un video que solo tiene el resumen listo, ver /api/videos/:id/data)
 * sin arriesgarse a mandar un correo real por accidente — esta funcion no tiene transporter ni
 * conoce EMAIL_CONFIG. */
export function buildEmailHtml({ videoId, title, model, client, summaryBody, fullContent }) {
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // summaryBody, NOT markdown: this template lays out the two parts itself, with its own
    // "Contenido completo" heading before fullContentHtml below. `markdown` is the complete
    // standalone document (summary + transcript) for the .md file, so using it here would
    // render the whole transcript twice.
    const bodyHtml = marked(summaryBody || '');
    const fullContentHtml = marked((fullContent || '') + "\n\n");

    // Estilo minimalista 2026 (referencia: redesign.md). Sin boton rojo, sin serif, sin
    // bordes negros de 1px — un link mono sutil en vez del botón, y las imágenes que
    // vengan dentro del markdown (diagramas tipo RAG) entran en una card blanca con
    // borde en vez de flotar sueltas. Email, no web: todo el CSS va inline/en <style>
    // dentro de <head>, sin depender de nada externo salvo la fuente de Google Fonts
    // (con una pila de fallback de sistema por si el cliente de correo la bloquea).
    return `
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- Gmail, Apple Mail y Outlook.com "adivinan" un tema oscuro para el email y reescriben los
         colores por su cuenta si no les dices lo contrario — estas dos lineas son las que
         reconocen la mayoria de clientes para decir "este email YA esta diseñado, no lo toques". -->
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        /* Misma identidad que la app (globals.css): violet #5B4FE5, Fraunces para titulos,
           IBM Plex Sans para el cuerpo — el email dejo de ser un documento aparte con su
           propia paleta gris/Inter, ahora se reconoce como la misma herramienta. */
        body {
            margin: 0; padding: 40px 16px; background: #F6F6FB !important;
            font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            color: #191A2E !important;
        }
        .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .container { background: #FFFFFF !important; max-width: 600px; margin: 0 auto; border-radius: 16px; padding: 32px; border: 1px solid #E2E1F0; }
        /* El transcript completo va en su PROPIA tarjeta, no metida dentro de la del resumen —
           dos .container separados, con el fondo de la pagina (#F6F6FB) de por medio como hueco
           real entre las dos, no un panel anidado con borde dentro del mismo bloque. */
        .container + .container { margin-top: 32px; }
        .container h2:first-child { margin-top: 0; }
        /* Tinte violeta-grisaceo (el --color-accent de la app) en vez de un gris neutro — sigue
           siendo claramente distinto del blanco de arriba, pero ahora es "de la casa" en vez de
           un gris cualquiera. */
        .container-full { background: #ECEBF7 !important; border: 1px solid #D3D0EE; }
        .transcript-note { margin: -2px 0 20px; font-size: 13px; color: #676A85 !important; }
        .thumb-link { display: block; }
        .thumb { width: 100%; border-radius: 12px; display: block; }
        .yt-link {
            display: inline-block; margin-top: 16px; font-size: 13px; font-weight: 500; color: #5B4FE5 !important;
            text-decoration: none; letter-spacing: 0.01em;
        }
        .yt-link:hover { color: #4A3FD1 !important; }
        h1 {
            font-family: 'Fraunces', 'Iowan Old Style', Georgia, serif;
            font-size: 30px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25;
            color: #191A2E !important; margin: 18px 0 10px;
        }
        h2 {
            font-family: 'Fraunces', 'Iowan Old Style', Georgia, serif;
            font-size: 20px; font-weight: 600; color: #191A2E !important; margin: 0 0 4px;
        }
        p { font-size: 15px; line-height: 26px; color: #191A2E !important; margin: 0 0 16px; }
        ul, ol { padding-left: 20px; margin: 0 0 16px; }
        li { font-size: 15px; line-height: 26px; color: #191A2E !important; margin-bottom: 12px; }
        a { color: #5B4FE5 !important; }
        strong { color: #191A2E !important; font-weight: 600; }
        hr { border: none; border-top: 1px solid #E2E1F0; margin: 28px 0; }
        /* Cualquier imagen dentro del contenido (diagramas, capturas) va en una card con borde,
           en vez de suelta a ancho completo — esto cubre el diagrama RAG y cualquier otro. */
        .content img {
            display: block; max-width: 100%; border: 1px solid #E2E1F0; border-radius: 12px;
            padding: 8px; background: #FFFFFF !important; margin: 8px 0 16px;
        }
        .footer {
            margin-top: 32px; padding-top: 18px; border-top: 1px solid #D3D0EE;
            display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
            font-size: 12px; color: #676A85 !important;
        }
        .footer-tag {
            display: inline-block; padding: 2px 8px; border-radius: 999px; background: #FFFFFF !important;
            border: 1px solid #D3D0EE; color: #5B4FE5 !important; font-size: 11px;
        }
        @media (max-width: 480px) {
            body { padding: 20px 8px; }
            .container { padding: 20px; border-radius: 12px; }
            h1 { font-size: 25px; }
            h2 { font-size: 18px; }
        }
        /* Apple Mail y algunos clientes ignoran las meta tags de arriba y aplican su propio
           "smart dark mode" via esta media query — reafirmar los MISMOS colores claros aqui
           adentro, con !important, es lo que realmente los neutraliza (en vez de dejarles la
           puerta abierta a adivinar el negativo de cada color ellos solos). */
        @media (prefers-color-scheme: dark) {
            body { background: #F6F6FB !important; color: #191A2E !important; }
            .container { background: #FFFFFF !important; border-color: #E2E1F0 !important; }
            .container-full { background: #ECEBF7 !important; border-color: #D3D0EE !important; }
            .transcript-note { color: #676A85 !important; }
            .yt-link { color: #5B4FE5 !important; }
            .yt-link:hover { color: #4A3FD1 !important; }
            h1, h2, strong { color: #191A2E !important; }
            a { color: #5B4FE5 !important; }
            p, li { color: #191A2E !important; }
            .content img { background: #FFFFFF !important; }
            .footer { color: #676A85 !important; border-top-color: #D3D0EE !important; }
            .footer-tag { background: #FFFFFF !important; border-color: #D3D0EE !important; color: #5B4FE5 !important; }
        }
        /* Outlook.com (web) marca los elementos que reescribio en modo oscuro con estos
           atributos generados — pisarlos de vuelta a los colores reales es el unico gancho
           documentado para ese cliente en concreto. */
        [data-ogsc] body { background: #F6F6FB !important; }
        [data-ogsc] .container { background: #FFFFFF !important; }
        [data-ogsc] .container-full { background: #ECEBF7 !important; border: 1px solid #D3D0EE !important; }
        [data-ogsc] h1, [data-ogsc] h2, [data-ogsc] p, [data-ogsc] li, [data-ogsc] a, [data-ogsc] strong {
            color: #191A2E !important;
        }
    </style>
    </head>
    <body>
        <div class="container">
            <a class="thumb-link" href="${videoUrl}">
                <img class="thumb" src="${thumbnailUrl}" alt="" />
            </a>
            <a class="yt-link mono" href="${videoUrl}">Ver en YouTube</a>

            <h1>${title}</h1>

            <div class="content">${bodyHtml}</div>
        </div>

        <div class="container container-full">
            <h2>Contenido completo</h2>
            <p class="transcript-note">Transcripción sin editar — referencia, no la versión pulida.</p>

            <div class="content">${fullContentHtml}</div>

            <div class="footer">
                <span class="mono footer-tag">${videoId}</span>
                <span class="mono">${model || 'N/A'}${client ? ` via ${client}` : ''}</span>
            </div>
        </div>
    </body>
    </html>
                `;
}

export class EmailStage extends BaseStage {
    constructor(logger) {
        super({
            name: 'email',
            inputDir: DIRS.EMAIL.INPUT,
            outputDir: DIRS.EMAIL.OUTPUT,
            errorDir: DIRS.EMAIL.ERROR,
            logger
        });

        this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });
    }

    async execute(anchorPath) {
        const videoId = extractVideoIdFromPath(anchorPath);

        const enrichedJsonPath = path.join(this.inputDir, `${videoId}.enriched.json`);
        const mdPath = path.join(this.inputDir, `${videoId}.summary.md`);

        try {
            const [enrichedJson] = await Promise.all([
                fs.readFile(enrichedJsonPath, 'utf-8'),
                fs.access(mdPath), // el .md tiene que existir aunque no se lea aqui — se mueve mas abajo
            ]);

            const enrichedData = JSON5.parse(enrichedJson);
            const title = enrichedData.title || 'YouTube Summary';

            const finalHtml = buildEmailHtml({
                videoId,
                title,
                model: enrichedData.model,
                client: enrichedData.client,
                summaryBody: enrichedData.summaryBody,
                fullContent: enrichedData.fullContent,
            });

            await this.transporter.sendMail({
                from: EMAIL_USER,
                to: EMAIL_CONFIG.to,
                bcc: EMAIL_CONFIG.bcc,
                subject: `[SUMMARY] ${title}`,
                html: finalHtml
            });

            // --- output ---
            const out = path.join(this.outputDir, `${videoId}.email.html`);
            await fs.writeFile(out, finalHtml);

            await fs.rename(path.join(this.inputDir, `${videoId}.enriched.json`), path.join(this.outputDir, `${videoId}.enriched.json`));
            await fs.rename(path.join(this.inputDir, `${videoId}.summary.md`), path.join(this.outputDir, `${videoId}.summary.md`));

            await this.logSuccess([enrichedJsonPath, mdPath], [enrichedJsonPath, mdPath, out]);

        } catch (err) {
            console.error(`❌ Email failed for ${videoId}`, err);

            await this.moveToError([enrichedJsonPath, mdPath], err);
        }
    }
}

export async function moveOutputs(srcDir, destDir, filterFn) {
    const files = await fs.readdir(srcDir);

    for (const f of files.filter(filterFn)) {
        await fs.rename(
            path.join(srcDir, f),
            path.join(destDir, f)
        );
    }
}

/** Igual que moveOutputs, pero reparte el MISMO fichero a varios directorios en vez de moverlo a
 * uno solo — para SUMMARIZE y REWRITE, que leen el mismo download/output cada una por su lado
 * (no una detras de otra) para poder usar modelos de IA distintos en paralelo de verdad. Copia a
 * todos los destinos salvo el ultimo, y al ultimo lo MUEVE — asi el fichero termina en todos los
 * sitios y no se queda huerfano en el directorio de origen. */
export async function fanOutOutputs(srcDir, destDirs, filterFn) {
    const files = await fs.readdir(srcDir);

    for (const f of files.filter(filterFn)) {
        const srcPath = path.join(srcDir, f);
        for (const destDir of destDirs.slice(0, -1)) {
            await fs.copyFile(srcPath, path.join(destDir, f));
        }
        await fs.rename(srcPath, path.join(destDirs[destDirs.length - 1], f));
    }
}

export function sleep(ms) {
    // `setTimeout` aqui es el de 'timers/promises' (importado arriba), ya devuelve una Promise.
    return setTimeout(ms);
}

/** Runs one stage as a queue worker instead of a one-shot batch.
 *
 * The old main() ran each stage as a hard barrier: ALL of download had to finish before ANY of
 * ai-summarize started, even though downloading (network + yt-dlp) and summarizing (the local GPU)
 * are entirely different resources that don't need to wait on each other. With 3 queued videos, the
 * 3rd video's transcript sat idle for two videos' worth of download time before the model ever saw it.
 *
 * Here each stage polls its OWN input folder and, as soon as a file finishes, moves its output
 * straight into the next stage's input — not batched at a stage boundary — so the next stage can
 * pick it up immediately instead of waiting for the whole batch. `upstreamDone` is a shared flag
 * object: this worker only exits once its own queue is empty AND upstream has confirmed no more
 * files are coming, which avoids the race of quitting on a momentarily-empty folder.
 *
 * `stage.execute()` already logs and moves failures to error/ for every stage; this adds one more
 * layer of protection around it because DownloadStage historically could throw past its own
 * try/catch, and one bad video must not take the whole worker down with it. */
export async function runStageWorker(stage, { filterInput, upstreamDone, nextInputDir, nextInputDirs, filterMove, pollMs = 250, isPaused }) {
    while (true) {
        // Pausada desde Settings ("dame tiempo a configurar otro LLM"): no se toca listInputs ni
        // execute, así que lo que ya hay en input/ se queda esperando intacto hasta reanudar —
        // no es lo mismo que parar el proceso, el worker sigue vivo y solo deja de recoger trabajo.
        if (isPaused && isPaused()) {
            await sleep(pollMs);
            continue;
        }

        const files = await stage.listInputs(filterInput);

        for (const file of files) {
            // El worker procesa un fichero a la vez — esto es lo que le dice a server.js CUAL
            // de los que estan en input/ es el que de verdad esta corriendo ahora mismo, para que
            // la UI no pinte a los otros 3 en cola como si tambien estuvieran activos.
            stage.activeVideoId = extractVideoIdFromPath(file);
            try {
                await stage.execute(path.join(stage.inputDir, file));
            } catch (err) {
                // ya se registro y se movio a error/ dentro de stage.execute()
            }
            stage.activeVideoId = null;
            // nextInputDirs (plural) es para el reparto DOWNLOAD -> SUMMARIZE + REWRITE al mismo
            // tiempo — nextInputDir (singular) sigue siendo el caso normal de una sola etapa
            // siguiente.
            if (nextInputDirs) {
                await fanOutOutputs(stage.outputDir, nextInputDirs, filterMove ?? filterInput);
            } else if (nextInputDir) {
                await moveOutputs(stage.outputDir, nextInputDir, filterMove ?? filterInput);
            }
        }

        if (files.length === 0) {
            if (upstreamDone.v) return;
            await sleep(pollMs);
        }
    }
}

// ==========================================================
// MAIN EXECUTION
// ==========================================================

async function main() {
    // 1. Configure AI — el modo CLI no tiene Settings por proveedor/etapa (eso es cosa de
    // server.js), asi que aqui summarize y rewrite usan el mismo AI_PROVIDER de .env para los
    // dos. Si se necesitan modelos distintos por etapa desde la terminal, hay que correr
    // server.js en vez de esto.
    const provider = process.env.AI_PROVIDER || 'lmstudio';
    const summarizeAiClient = createAiClient(provider);
    const rewriteAiClient = createAiClient(provider);

    const logger = new EventLogger();

    const processInputsStage = new ProcessInputsStage(logger);
    const downloader = new DownloadStage(logger);
    const summarizer = new SummarizeStage(summarizeAiClient, logger);
    const rewriter = new RewriteStage(rewriteAiClient, logger);
    const interpretSummaryStage = new InterpretSummaryStage(logger);
    const emailer = new EmailStage(logger);

    //const pipeline = new PipelineManager(aiClient);

    // 2. Initialize directories
    await initDirs();

    // 3. Parse Arguments
    const args = process.argv.slice(2);

    // Check for explicit flags
    const doProcessInputs = args.includes('--process-inputs') || args.includes('--all');
    const explicitDownload = args.includes('--download') || args.includes('--all');
    const doSummarize = args.includes('--summarize') || args.includes('--all');
    const doEmail = args.includes('--email') || args.includes('--all');
    const doAll = args.includes('--all');

    // Handle URLs (Multiple support)
    // Logic: Find the index of --url, then take the next argument.
    // We split by commas to allow: --url "https://y.com/1, https://y.com/2"
    let urlsToProcess = [];
    const urlArgIndex = args.indexOf('--url');

    if (urlArgIndex !== -1 && args[urlArgIndex + 1]) {
        const urlRaw = args[urlArgIndex + 1];
        // Split by comma, trim whitespace, and filter out empty strings
        urlsToProcess = urlRaw.split(',').map(u => u.trim()).filter(u => u.length > 0);
    }

    // IMPLICIT LOGIC: If URLs are provided, we MUST download them.
    // So, doDownload is true if explicitly requested OR if implicit via --url OR if --all
    let doDownload = explicitDownload || urlsToProcess.length > 0 || doAll;

    // --- HELP TEXT ---
    if (args.length === 0) {
        console.log(`
Usage: node script.js [flags] [--url "http..., http..."]

Flags:
  --url "url1,url2" : Specifies video URLs (comma separated). Implicitly triggers download.
  --download        : Force download mode (usually redundant if --url is used).
  --summarize       : Processes ALL files in '1_raw_transcripts' -> '2_summaries'.
  --email           : Sends ALL files in '2_summaries' -> email -> 'done'.
  --all             : Runs the entire process chain (Download -> Summarize -> Email).

Examples:
  1. Download multiple videos (Implicit download):
     node script.js --url "https://youtu.be/abc, https://youtu.be/xyz"
  
  2. Download and summarize immediately:
     node script.js --summarize --url "https://youtu.be/abc"

  3. Process existing pending files (no new download):
     node script.js --summarize --email

  4. Full cycle (Download, Summarize, Email):
     node script.js --all --url "https://youtu.be/abc"
        `);
        return;
    }

    // --- EJECUCION CONCURRENTE POR ETAPAS ---
    //
    // Antes cada etapa era una barrera dura: TODA la descarga tenia que terminar antes de que
    // empezara CUALQUIER resumen, aunque descargar (red + yt-dlp) y resumir (la GPU local) son
    // recursos completamente distintos que no necesitan esperarse entre si. Con 3 videos en
    // cola, el transcript del tercero se quedaba esperando el tiempo de descarga de los otros
    // dos antes de que el modelo lo viera siquiera.
    //
    // Ahora cada etapa corre como un worker (runStageWorker) que vigila su propia carpeta de
    // entrada y traspasa cada fichero a la siguiente etapa en cuanto termina, no por lotes, asi
    // que las etapas se solapan en vez de esperarse. Los flags done.* le dicen a la etapa de
    // abajo cuando ya no va a llegar nada mas de la de arriba, para que sepa cuando parar en vez
    // de vigilar una carpeta vacia para siempre.

    console.log('\n' + '='.repeat(60));
    console.log('STARTING PROCESSING PIPELINE');
    console.log('='.repeat(60));

    // STAGE 0: Process Inputs — sincrono, no es un worker: corre una sola vez al arrancar.
    if (doProcessInputs || urlsToProcess.length > 0) {
        console.log(`\n🟣 [STAGE 0] Processing inputs...`);

        const generatedCount = await processInputsStage.execute(urlsToProcess);

        if (generatedCount > 0) {
            console.log(`✅ Generated ${generatedCount} download job(s)`);
            // Si generamos archivos, forzamos la ejecución del download
            doDownload = true;
        } else if (doDownload) {
            console.log('⚠️ No new inputs generated, but --download was specified');
        }
    }

    const downloadDone = { v: !doDownload };
    const summarizeDone = { v: !doSummarize };
    const rewriteDone = { v: !doSummarize };
    // InterpretSummary no puede avanzar hasta que las DOS mitades hayan terminado — un getter en
    // vez de un valor fijo, para que siga leyendo el estado real de las otras dos cada vez que
    // runStageWorker consulta upstreamDone.v.
    const summarizeAndRewriteDone = { get v() { return summarizeDone.v && rewriteDone.v; } };
    const interpretSummaryDone = { v: !doSummarize };

    // El fichero que dispara InterpretSummary es SIEMPRE el .rewrite-part.json — solo cuenta
    // como "listo" cuando su hermano .summary-part.json ya esta en la misma carpeta. El tercer
    // argumento de un callback de .filter() es el array completo, asi no hace falta releer el
    // directorio a mano por cada fichero.
    const interpretJoinFilter = (f, _i, allFiles) => {
        if (!f.endsWith('.rewrite-part.json')) return false;
        const videoId = f.slice(0, -'.rewrite-part.json'.length);
        return allFiles.includes(`${videoId}.summary-part.json`);
    };

    const workers = [];

    // 1. Stage: Download
    if (doDownload) {
        // Recoge tambien lo que el STAGE 0 haya generado en una llamada previa a este proceso.
        await moveOutputs(DIRS.PROCESS_INPUTS.OUTPUT, DIRS.DOWNLOAD.INPUT, f => f.endsWith('.json'));

        console.log(`\n🟣 [STAGE 1] Watching for files to download in: ${DIRS.DOWNLOAD.INPUT}`);
        workers.push((async () => {
            // Upstream ya es {v:true}: STAGE 0 es sincrono y ya termino antes de llegar aqui.
            await runStageWorker(downloader, {
                filterInput: f => f.endsWith('.json'),
                upstreamDone: { v: true },
                nextInputDirs: [DIRS.SUMMARIZE.INPUT, DIRS.REWRITE.INPUT],
                filterMove: f => f.endsWith('.json'),
            });
            downloadDone.v = true;
        })());
    }

    // 2A. Stage: Summarize (resumen corto)
    if (doSummarize) {
        // Recoge tambien lo que quedara pendiente de descargas de un proceso anterior.
        await fanOutOutputs(DIRS.DOWNLOAD.OUTPUT, [DIRS.SUMMARIZE.INPUT, DIRS.REWRITE.INPUT], f => f.endsWith('.json'));

        console.log(`\n🟣 [STAGE 2A] Watching for files to summarize in: ${DIRS.SUMMARIZE.INPUT}`);
        workers.push((async () => {
            await runStageWorker(summarizer, {
                filterInput: f => f.endsWith('.json'),
                upstreamDone: downloadDone,
                nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
                filterMove: f => f.endsWith('.summary-part.json'),
            });
            summarizeDone.v = true;
        })());

        // 2B. Stage: Rewrite (reescritura/traduccion completa) — en PARALELO con 2A, no detras:
        // lee el mismo download/output, con su propio modelo de IA, y ninguna de las dos espera
        // a la otra.
        console.log(`\n🟣 [STAGE 2B] Watching for files to rewrite in: ${DIRS.REWRITE.INPUT}`);
        workers.push((async () => {
            await runStageWorker(rewriter, {
                filterInput: f => f.endsWith('.json'),
                upstreamDone: downloadDone,
                nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
                filterMove: f => f.endsWith('.rewrite-part.json'),
            });
            rewriteDone.v = true;
        })());

        // 2C. Stage: Interpret Summary — junta las dos mitades.
        console.log(`\n🟣 [STAGE 2C] Watching for files to interpret in: ${DIRS.INTERPRET_SUMMARY.INPUT}`);
        workers.push((async () => {
            await runStageWorker(interpretSummaryStage, {
                filterInput: interpretJoinFilter,
                upstreamDone: summarizeAndRewriteDone,
                nextInputDir: DIRS.EMAIL.INPUT,
                filterMove: f => f.endsWith('.json') || f.endsWith('.md'),
            });
            interpretSummaryDone.v = true;
        })());
    }

    // 3. Stage: Email
    if (doEmail) {
        // Recoge tambien lo que quedara pendiente de un interpret-summary anterior — esto es lo
        // que permite lanzar `--email` solo para vaciar la cola sin volver a resumir nada.
        await moveOutputs(DIRS.INTERPRET_SUMMARY.OUTPUT, DIRS.EMAIL.INPUT, f => f.endsWith('.json') || f.endsWith('.md'));

        console.log(`\n🟢 [STAGE 3] Watching for summaries to email in: ${DIRS.EMAIL.INPUT}`);
        workers.push((async () => {
            // .enriched.json es el fichero ancla que dispara el envio de cada video.
            await runStageWorker(emailer, {
                filterInput: f => f.endsWith('.enriched.json'),
                upstreamDone: interpretSummaryDone,
                nextInputDir: DIRS.DONE, // reemplaza la limpieza final de antes: se mueve video a video
                filterMove: () => true, // .enriched.json + .summary.md + .email.html
            });
        })());
    }

    if (workers.length > 0) {
        await Promise.all(workers);
        console.log(`\n✅ [FINISH] Pipeline completo.`);
    }
}

// Solo se autoejecuta cuando se invoca directamente (`node resumir_video.js ...`);
// server.js importa las clases y funciones de este modulo sin querer disparar el CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
