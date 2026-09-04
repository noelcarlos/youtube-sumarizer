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
    // STAGE 2A — AI SUMMARIZE
    // ======================================================
    AI_SUMMARIZE: {
        INPUT: path.join(BASE, 'ai-summarize/input'),
        OUTPUT: path.join(BASE, 'ai-summarize/output'),
        ERROR: path.join(BASE, 'ai-summarize/error')
    },

    // ======================================================
    // STAGE 2B — INTERPRET SUMMARY
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
const EMAIL_USER = "david.rey.1040@gmail.com";
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = "noel.carlos@gmail.com";
//const EMAIL_BCC = "kl2053258@gmail.com";
//const EMAIL_BCC = "kl2053258@gmail.com,manuelvargash95@gmail.com";
const EMAIL_BCC = "";
const OVERRIDE_LANG = null; //"Español"; // Set to null to auto-detect

// ==========================================================
// SECTION 1: AI CLIENTS (Dependency Injection)
// ==========================================================

class IModelClient {
    async generateContent(promptContent) { throw new Error("Method 'generateContent' is not implemented."); }
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

class GeminiClient extends IModelClient {
    constructor(apiKey, modelName) {
        super();
        this.ai = new GoogleGenAI({ apiKey });
        this.modelName = modelName;
    }
    async generateContent(promptContent) {
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
    async generateContent(promptContent) {
        console.log(`   🤖 [${this.label}] Request → prompt length: ${promptContent.length} chars (timeout: ${Math.round(this.ai.timeout / 1000)}s, max_tokens: provider default)`);

        const startedAt = Date.now();
        let response;
        try {
            response = await withConnectionRetry(this.label, 3, () => this.ai.chat.completions.create({
                model: this.modelName,
                messages: [{ role: "user", content: promptContent }],
                temperature: 0.1,
            }));
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
    async generateContent(promptContent) {
        console.log(`   🤖 [LMStudio] Request → prompt length: ${promptContent.length} chars (timeout: ${Math.round(this.ai.timeout / 1000)}s, max_tokens: ${LOCAL_MAX_OUTPUT_TOKENS.toLocaleString()})`);

        const startedAt = Date.now();
        let response;
        try {
            response = await withConnectionRetry("LMStudio", 3, () => this.ai.chat.completions.create({
                model: this.modelName,
                messages: [{ role: "user", content: promptContent }],
                temperature: 0,
                max_tokens: LOCAL_MAX_OUTPUT_TOKENS,
            }));
        } catch (err) {
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            console.error(`   ❌ [LMStudio] API error after ${elapsedSec}s: ${err.message}`);
            if (err.response?.data) console.error(`   ❌ [LMStudio] Response data:`, JSON.stringify(err.response.data));
            throw err;
        }

        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        let content = response.choices[0].message.content;
        let rawContent = content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '') // Clean "think" tags

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

export function createAiClient(provider) {
    switch (provider) {
        case 'gemini': return new GeminiClient(requireKey(GEMINI_API_KEY, provider, 'GEMINI_API_KEY'), GEMINI_MODEL);
        case 'deepseek': return new OpenAICompatibleClient(requireKey(DEEPSEEK_API_KEY, provider, 'DEEPSEEK_API_KEY'), DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, 10 * 60 * 1000, "DeepSeek");
        case 'nvidia': return new OpenAICompatibleClient(requireKey(NVIDIA_API_KEY, provider, 'NVIDIA_API_KEY'), NVIDIA_BASE_URL, NVIDIA_MODEL, NVIDIA_TIMEOUT_MS, "NVIDIA");
        case 'lmstudio': return new LMStudioClient(LMSTUDIO_API_KEY, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL_NAME, LMSTUDIO_TIMEOUT_MS);
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

    _parseSubtitleContent(raw, fmt) {
        if (fmt === 'json3') {
            try {
                const json = JSON.parse(raw);
                const text = (json.events || [])
                    .flatMap(e => (e.segs || []).map(s => s.utf8 || ''))
                    .join(' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                return text.length > 50 ? text : null;
            } catch { return null; }
        }
        if (fmt === 'vtt') {
            const text = raw
                .replace(/WEBVTT[\s\S]*?\n\n/, '')
                .replace(/\d{2}:\d{2}:\d{2}.\d{3} --> \d{2}:\d{2}:\d{2}.\d{3}[^\n]*/g, '')
                .replace(/<[^>]*>/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            return text.length > 50 ? text : null;
        }
        // raw XML: <transcript><text ...>content</text></transcript>
        const text = raw
            .replace(/<text[^>]*>/g, '').replace(/<\/text>/g, ' ').replace(/<[^>]*>/g, '')
            .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        return text.length > 50 ? text : null;
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

export class AiSummarizeStage extends BaseStage {
    constructor(aiClient, logger) {
        super({
            name: 'AI Summarize',
            inputDir: DIRS.AI_SUMMARIZE.INPUT,
            outputDir: DIRS.AI_SUMMARIZE.OUTPUT,
            errorDir: DIRS.AI_SUMMARIZE.ERROR,
            logger
        });
        this.aiClient = aiClient;
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
     * overall. Re-measure before changing this, and re-measure when changing model. */
    chunkTranscript(text, maxChars = 12000) {
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

        for (let i = 0; i < chunks.length; i++) {
            const chunkStart = Date.now();
            const input = chunks[i];

            console.log(`   ▶️  Chunk ${i + 1}/${chunks.length} (${input.length} chars) — iniciando...`);

            const prompt = this.buildChunkPrompt(input, i + 1, chunks.length);
            const { rawContent } = await this.aiClient.generateContent(prompt);
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

        return results;
    }

    async buildRawTranscript(rawTranscript) {
        const chunks = this.chunkTranscript(rawTranscript);
        console.log(`   ✂️  Transcript (${rawTranscript.length} chars) split into ${chunks.length} chunk(s): [${chunks.map(c => c.length).join(', ')}]`);
        const chunkResults = await this.processChunks(chunks);

        return chunkResults;
    }

    async _callAI(transcript) {

        // Two short scalar fields on their own lines, then the prose as the rest of the message.
        // The summary is Markdown with headings, bullets and quotes, so it cannot live inside a JSON
        // string without flawless escaping — see buildChunkPrompt for why that failed. Here the
        // scalars are trivially parseable and the prose needs no parsing at all.
        //
        // Note there is deliberately no "model_used" field. It used to be requested, and the skeleton
        // in this very prompt showed it pre-filled as "deepseek" — which the model dutifully copied,
        // so every summary reported "deepseek" no matter what actually ran. The real model name is
        // already known in code and does not need to round-trip through the model.
        const prompt = `
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


        console.log(`   📝 [PASO 1/2] Generando resumen corto...`);
        const step1Start = Date.now();
        const { client, model, rawContent } = await this.aiClient.generateContent(prompt);
        console.log(`   ✅ [PASO 1/2] Resumen corto listo en ${Math.round((Date.now() - step1Start) / 1000)}s`);

        console.log(`   📝 [PASO 2/2] Generando versión completa reescrita (chunk por chunk, más lento)...`);
        const step2Start = Date.now();
        const fullContentChunks = await this.buildRawTranscript(transcript) || ""
        console.log(`   ✅ [PASO 2/2] Versión completa lista en ${Math.round((Date.now() - step2Start) / 1000)}s`);

        return {
            fullContentChunks: fullContentChunks,
            rawContent,
            client,
            model,
        };
    }

    async execute(filePath) {

        const videoId = extractVideoIdFromPath(filePath);

        const fileStart = Date.now();
        try {
            console.log(`   Processing: ${filePath}...`);

            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON5.parse(content);

            // sanity check (opcional pero recomendado)
            if (data.videoId && data.videoId !== videoId) {
                console.warn(
                    `⚠️ videoId mismatch: filename=${videoId}, json=${data.videoId}`
                );
            }

            // Generate summary
            const { client, model, rawContent, fullContentChunks } = await this._callAI(data.transcript);

            const enrichedData = {
                ...data,
                model,
                client,
                summaryDate: new Date().toISOString(),
                rawContent,
                fullContentChunks
            };

            const outPath = path.join(
                this.outputDir,
                `${data.videoId}.ai.raw.json`
            );

            await fs.writeFile(outPath, JSON.stringify(enrichedData, null, 2));

            await this.logSuccess([filePath], [outPath]);

            console.log(`   🏁 ${videoId} completado en ${Math.round((Date.now() - fileStart) / 1000)}s`);

        } catch (err) {
            console.error(`   ❌ Error processing ${filePath}: ${err.message}`, err);
            await this.moveToError([filePath], err);
        }
    }
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

    /** Reads the TITLE / LANGUAGE / SUMMARY: shape that AiSummarizeStage._callAI asks for.
     *
     * This replaced a JSON parse guarded by three escalating repair passes (a string-escaping state
     * machine, a "content"-value regex rewrite, and a code-fence stripper). They existed because the
     * summary's Markdown had to survive being quoted inside JSON, and they still lost two of three
     * videos in one run. Here the scalars are two anchored lines and the prose is simply the rest of
     * the message, so nothing about the summary's own punctuation can break parsing.
     *
     * The scalars are tolerant on purpose — leading indentation, optional bold, `**TITLE:**` — but
     * the SUMMARY: marker is required: without it there is no way to tell where prose begins, and
     * guessing would silently fold the title line into the body. */
    parseSummary(raw) {
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

    /** The chunks arrive as plain Markdown in the order they were generated, so "assembling" is a
     * join. Order comes from the array index, not from a model-reported chunk_index that used to be
     * sorted on — and a chunk can no longer be dropped here, because there is nothing left to parse. */
    assembleFullContent(chunks) {
        return (chunks || [])
            .map(c => (typeof c === 'string' ? c : '').trim())
            .filter(Boolean)
            .join('\n\n');
    }

    async execute(filePath) {

        const videoId = extractVideoIdFromPath(filePath);

        try {
            //const inputPath = path.join(DIRS.RAW, file);
            console.log(`   Processing: ${filePath}...`);

            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON5.parse(content);

            // sanity check (opcional pero recomendado)
            if (data.videoId && data.videoId !== videoId) {
                console.warn(
                    `⚠️ videoId mismatch: filename=${videoId}, json=${data.videoId}`
                );
            }

            const parsed = this.parseSummary(data.rawContent);
            const fullContent = this.assembleFullContent(data.fullContentChunks);

            const title = parsed.title || "Untitled Video";

            // The .md used to hold only the short summary, while the email template pulled BOTH
            // summaryBody and fullContent — so the file on disk silently lacked the transcript
            // rewrite that took the bulk of the run's compute. Same document in both places now.
            const markdown = [
                `# ${title}`,
                parsed.content,
                fullContent ? `---\n\n## Transcripción completa\n\n${fullContent}` : '',
            ].filter(Boolean).join('\n\n');

            const enrichedData = {
                ...data,
                title,
                language: parsed.language || "Unknown",
                // data.model is what AiSummarizeStage recorded from the client that actually ran.
                // This used to read `parsed.model_used || model` — a bare `model` that was never in
                // scope, so any transcript without the field crashed with a ReferenceError instead.
                model: data.model,
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

            await this.logSuccess([filePath], [jsonOut, mdOut]);

        } catch (err) {
            console.error(`   ❌ Error processing ${filePath}: ${err.message}`, err);
            await this.moveToError([filePath], err);
        }
    }
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

        const enrichedJsonPath = path.join(
            this.inputDir,
            `${videoId}.enriched.json`
        );

        const mdPath = path.join(
            this.inputDir,
            `${videoId}.summary.md`
        );

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        try {
            // --- cargar inputs ---
            const [enrichedJson, markdown] = await Promise.all([
                fs.readFile(enrichedJsonPath, 'utf-8'),
                fs.readFile(mdPath, 'utf-8')
            ]);

            const enrichedData = JSON5.parse(enrichedJson);

            const title = enrichedData.title || 'YouTube Summary';

            // --- render and send HTML ---
            const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

            // 3) Convert Markdown → HTML
            // summaryBody, NOT markdown: this template lays out the two parts itself, with its own
            // "Contenido completo" heading before fullContentHtml below. `markdown` is now the
            // complete standalone document (summary + transcript) for the .md file, so using it here
            // would render the whole transcript twice.
            const bodyHtml = marked(enrichedData.summaryBody || '');

            // console.log(`   fullContent for: ${enrichedData.fullContent.substring(0, 120)}...`,);
            const fullContentHtml = marked(enrichedData.fullContent + "\n\n");

            // 4) Build HTML Email
            // Estilo minimalista 2026 (referencia: redesign.md). Sin boton rojo, sin serif, sin
            // bordes negros de 1px — un link mono sutil en vez del botón, y las imágenes que
            // vengan dentro del markdown (diagramas tipo RAG) entran en una card blanca con
            // borde en vez de flotar sueltas. Email, no web: todo el CSS va inline/en <style>
            // dentro de <head>, sin depender de nada externo salvo la fuente de Google Fonts
            // (con una pila de fallback de sistema por si el cliente de correo la bloquea).
            const finalHtml = `
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body {
            margin: 0; padding: 32px 16px; background: #FAFAFA;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            color: #3F3F46;
        }
        .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .container { background: #FFFFFF; max-width: 600px; margin: 0 auto; border-radius: 16px; padding: 32px; }
        .thumb-link { display: block; }
        .thumb { width: 100%; border-radius: 12px; display: block; }
        .yt-link {
            display: inline-block; margin-top: 16px; font-size: 13px; color: #71717A;
            text-decoration: none; letter-spacing: 0.01em;
        }
        .yt-link:hover { color: #18181B; }
        h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.01em; color: #18181B; margin: 16px 0 8px; }
        h2 { font-size: 20px; font-weight: 600; color: #18181B; margin: 32px 0 12px; }
        p { font-size: 15px; line-height: 26px; color: #3F3F46; margin: 0 0 16px; }
        ul, ol { padding-left: 20px; margin: 0 0 16px; }
        li { font-size: 15px; line-height: 26px; color: #3F3F46; margin-bottom: 12px; }
        a { color: #18181B; }
        strong { color: #18181B; font-weight: 600; }
        hr { border: none; border-top: 1px solid #E4E4E7; margin: 28px 0; }
        /* Cualquier imagen dentro del contenido (diagramas, capturas) va en una card con borde,
           en vez de suelta a ancho completo — esto cubre el diagrama RAG y cualquier otro. */
        .content img {
            display: block; max-width: 100%; border: 1px solid #E4E4E7; border-radius: 12px;
            padding: 8px; background: #FFFFFF; margin: 8px 0 16px;
        }
        .footer {
            margin-top: 40px; padding-top: 20px; border-top: 1px solid #E4E4E7;
            font-size: 11px; color: #A1A1AA;
        }
        @media (max-width: 480px) {
            body { padding: 16px 8px; }
            .container { padding: 20px; border-radius: 12px; }
            h1 { font-size: 24px; }
            h2 { font-size: 18px; }
        }
    </style>
    </head>
    <body>
        <div class="container">
            <a class="thumb-link" href="${videoUrl}">
                <img class="thumb" src="${thumbnailUrl}" alt="" />
            </a>
            <a class="yt-link mono" href="${videoUrl}">Ver en YouTube →</a>

            <h1>${title}</h1>

            <div class="content">${bodyHtml}</div>

            <h2>Contenido completo</h2>

            <div class="content">${fullContentHtml}</div>

            <p class="footer mono">
                Video ID: ${videoId} · Model: ${enrichedData.model || 'N/A'} · Client: ${enrichedData.client || 'N/A'}
            </p>
        </div>
    </body>
    </html>
                `;

            // 5) Send email
            await transporter.sendMail({
                from: EMAIL_USER,
                to: EMAIL_TO,
                bcc: EMAIL_BCC,
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
export async function runStageWorker(stage, { filterInput, upstreamDone, nextInputDir, filterMove, pollMs = 250 }) {
    while (true) {
        const files = await stage.listInputs(filterInput);

        for (const file of files) {
            try {
                await stage.execute(path.join(stage.inputDir, file));
            } catch (err) {
                // ya se registro y se movio a error/ dentro de stage.execute()
            }
            if (nextInputDir) {
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
    // 1. Configure AI
    // Options: 'lmstudio' (local), 'nvidia', 'gemini', 'deepseek'
    const provider = process.env.AI_PROVIDER || 'lmstudio';
    const aiClient = createAiClient(provider);

    const logger = new EventLogger();

    const processInputsStage = new ProcessInputsStage(logger);
    const downloader = new DownloadStage(logger);
    const aiSummarizer = new AiSummarizeStage(aiClient, logger);
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
    const aiSummarizeDone = { v: !doSummarize };
    const interpretSummaryDone = { v: !doSummarize };

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
                nextInputDir: DIRS.AI_SUMMARIZE.INPUT,
                filterMove: f => f.endsWith('.json'),
            });
            downloadDone.v = true;
        })());
    }

    // 2A. Stage: AI Summarize
    if (doSummarize) {
        // Recoge tambien lo que quedara pendiente de descargas de un proceso anterior.
        await moveOutputs(DIRS.DOWNLOAD.OUTPUT, DIRS.AI_SUMMARIZE.INPUT, f => f.endsWith('.json'));

        console.log(`\n🟣 [STAGE 2A] Watching for files to summarize in: ${DIRS.AI_SUMMARIZE.INPUT}`);
        workers.push((async () => {
            await runStageWorker(aiSummarizer, {
                filterInput: f => f.endsWith('.json'),
                upstreamDone: downloadDone,
                nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
                filterMove: f => f.endsWith('.json'),
            });
            aiSummarizeDone.v = true;
        })());

        // 2B. Stage: Interpret Summary
        // Recoge tambien lo que quedara pendiente de un ai-summarize anterior.
        await moveOutputs(DIRS.AI_SUMMARIZE.OUTPUT, DIRS.INTERPRET_SUMMARY.INPUT, f => f.endsWith('.json'));

        console.log(`\n🟣 [STAGE 2B] Watching for files to interpret in: ${DIRS.INTERPRET_SUMMARY.INPUT}`);
        workers.push((async () => {
            await runStageWorker(interpretSummaryStage, {
                filterInput: f => f.endsWith('.json'),
                upstreamDone: aiSummarizeDone,
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
