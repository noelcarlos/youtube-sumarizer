// ==========================================================
// LIBRARY IMPORTS
// ==========================================================
import { GoogleGenAI } from '@google/genai';
import { OpenAI } from 'openai';
import { YoutubeTranscript } from '@danielxceron/youtube-transcript';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URL } from 'url';
import * as nodemailer from 'nodemailer';
import { marked } from 'marked';
import dotenv from 'dotenv';
import JSON5 from 'json5';

dotenv.config();

// ==========================================================
// CONFIGURATION (CONSTANTES)
// ==========================================================

// --- PIPELINE DIRECTORIES ---
const BASE = './pipeline-data';

export const DIRS = {
    // ======================================================
    // STAGE 1 — DOWNLOAD
    // ======================================================
    DOWNLOAD: {
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

const LMSTUDIO_API_KEY = process.env.LMSTUDIO_API_KEY;
const LMSTUDIO_BASE_URL = "http://localhost:1234/v1";
const LMSTUDIO_MODEL_NAME = "openai/gpt-oss-20b";
// const LMSTUDIO_MODEL_NAME = "qwen2.5-14b-instruct-mlx"; 
//const LMSTUDIO_MODEL_NAME = "deepseek/deepseek-r1-0528-qwen3-8b"; 
// // "qwen2.5-14b-instruct-mlx"; // "mistralai/mistral-7b-instruct-v0.3"; // "openai/gpt-oss-20b"; // "deepseek-r1-distill-qwen-7b"; 

// --- EMAIL CONFIG ---
const EMAIL_USER = "david.rey.1040@gmail.com";
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = "noel.carlos@gmail.com";
const EMAIL_BCC = "kl2053258@gmail.com";
//const EMAIL_BCC = "kl2053258@gmail.com,manuelvargash95@gmail.com";
//const EMAIL_BCC = "";
const OVERRIDE_LANG = "Español"; // Set to null to auto-detect

// ==========================================================
// SECTION 1: AI CLIENTS (Dependency Injection)
// ==========================================================

class IModelClient {
    async generateContent(promptContent) { throw new Error("Method 'generateContent' is not implemented."); }
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
    constructor(apiKey, baseUrl, modelName) {
        super();
        this.ai = new OpenAI({ apiKey, baseURL: baseUrl });
        this.modelName = modelName;
    }
    async generateContent(promptContent) {
        const response = await this.ai.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptContent }],
            temperature: 0.1,
        });
        return { client: "OpenAI", model: this.modelName, rawContent: response.choices[0].message.content }
    }
}

class LMStudioClient extends IModelClient {
    constructor(apiKey, baseUrl, modelName) {
        super();
        this.ai = new OpenAI({ apiKey, baseURL: baseUrl });
        this.modelName = modelName;
    }
    async generateContent(promptContent) {
        const response = await this.ai.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptContent }],
            temperature: 0,
        });
        let content = response.choices[0].message.content;
        let rawContent = content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '') // Clean "think" tags
        return { client: "LMStudio", model: this.modelName, rawContent: rawContent }
    }
}

function createAiClient(provider) {
    switch (provider) {
        case 'gemini': return new GeminiClient(GEMINI_API_KEY, GEMINI_MODEL);
        case 'deepseek': return new OpenAICompatibleClient(DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL);
        case 'lmstudio': return new LMStudioClient(LMSTUDIO_API_KEY, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL_NAME);
        default: throw new Error(`Unknown provider: ${provider}`);
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

async function initDirs() {
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

class EventLogger {
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
// STAGE 1 — DOWNLOAD
// ==========================================================
class DownloadStage extends BaseStage {
    constructor(logger) {
        super({
            name: 'download',
            inputDir: null, // CLI
            outputDir: DIRS.DOWNLOAD.OUTPUT,
            errorDir: DIRS.DOWNLOAD.ERROR,
            logger
        });
    }

    extractVideoId(url) {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
        return u.searchParams.get('v');
    }

    async execute(url) {
        console.log(`\n🔵 [STAGE 1] Downloading content: ${url}`);

        const videoId = this.extractVideoId(url);
        if (!videoId) {
            console.error(`❌ Invalid URL: ${url}`);
            return;
        }

        try {
            // Fetch transcript
            const transcriptArray = await YoutubeTranscript.fetchTranscript(url);
            const transcriptText = transcriptArray.map(item => item.text).join(' ');

            // Create data object
            const data = {
                videoId: videoId,
                originalUrl: url,
                downloadDate: new Date().toISOString(),
                transcript: transcriptText
            };

            const outPath = path.join(this.outputDir, `${videoId}.json`);

            // Save to RAW folder
            await fs.writeFile(
                outPath,
                JSON.stringify(data, null, 2)
            );

            // await fs.writeFile(filePath, JSON.stringify(data, null, 2));

            await this.logSuccess([], [outPath]);

        } catch (error) {
            console.error(`❌ Error downloading: ${error.message}`, error);
            const errPath = path.join(this.errorDir, `${videoId}.json`);
            await fs.writeFile(errPath, JSON.stringify({ videoId, error: error.message }));
            throw err;
        }
    }
}

function extractVideoIdFromPath(filePath) {
    const base = path.basename(filePath);

    // soporta: videoId.json, videoId.raw.json, videoId.anything.json
    return base.split('.')[0];
}

class AiSummarizeStage extends BaseStage {
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

    extractJsonBlock(raw) {
        if (!raw) return raw;

        const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        return match ? match[1].trim() : raw.trim();
    }

    chunkTranscript(text, maxChars = 8000) {
        const paragraphs = text.split('\n\n');
        const chunks = [];

        let current = '';

        for (const p of paragraphs) {
            const candidate = current
                ? current + '\n\n' + p
                : p;

            if (candidate.length > maxChars) {
                if (current.trim().length > 0) {
                    chunks.push(current.trim());
                }
                current = p;
            } else {
                current = candidate;
            }
        }

        if (current.trim().length > 0) {
            chunks.push(current.trim());
        }

        return chunks;
    }

    buildChunkPrompt(chunk, index, total) {
        return `
            You are an expert Editor and Translator. You are processing PART ${index} of ${total}.

            ### GOAL
            Produce a **clean, native Spanish version** of the text, formatted with Markdown for readability.

            ### CRITICAL RULE: NO INTERLEAVING
            - **NEVER** output the original English text.
            - **NEVER** output "English text (Spanish translation)".
            - **REPLACE** the original text entirely with Spanish.
            - The audience speaks **ONLY SPANISH**.

            ### MARKDOWN FORMATTING RULES (Apply inside the "content" field):
            1. **Paragraphs & Dialogues:** You MUST use double line breaks (\n\n) to visually separate paragraphs and different speakers.
            2. **Emphasis:** Use **bold** (double asterisks) for key terms, emphasized words, or loud speech found in the source.
            3. **Structure:** Do not create big blocks of text. Break it down so it is easy to read.

            ### OUTPUT FORMAT (Strict JSON):
            Return ONLY a single valid JSON object. No code blocks. No intro text.
            Ensure the "content" string is properly escaped for JSON if necessary.

            {
                "chunk_index": ${index},
                "content": "Aquí va la traducción completa en Español formato MARKDOWN MANDATORY.\\n\\nUsa saltos de línea para separar párrafos.\\n\\nUsa **negrita** para resaltar ideas clave."
            }

            ### INPUT TEXT:
            ${chunk}
        `.trim();
    }

    async processChunks(chunks) {
        const results = [];

        for (let i = 0; i < chunks.length; i++) {
            const prompt = this.buildChunkPrompt(chunks[i], i + 1, chunks.length);
            const { client, model, rawContent } = await this.aiClient.generateContent(prompt);

            console.log(`   Processed chunk ${i + 1}/${chunks.length} ...`);

            //console.log(rawContent);

            //const parsed = JSON5.parse(rawContent);

            // console.log(rawContent);

            // console.log(`   Processed chunk ${i + 1}/${chunks.length}: ${parsed.content.substring(0, 120)}.`);

            results.push(rawContent);
        }

        return results;
    }

    async buildRawTranscript(rawTranscript) {
        //const normalized = normalizeTranscript(rawTranscript);
        //const withSpeakers = detectSpeakers(normalized);
        const chunks = this.chunkTranscript(rawTranscript);

        const chunkResults = await this.processChunks(chunks);
        // const fullContent = this.assembleFullContent(chunkResults);

        //const finalPrompt = buildFinalPrompt(fullContent);
        //const finalResponse = await callLLM(finalPrompt);

        return chunkResults; //JSON.parse(finalResponse);
    }

    extractStrict(raw) {
        const match = raw.match(/BEGIN_JSON\s*([\s\S]*?)\s*END_JSON/);
        if (!match) {
            throw new Error("Invalid AI output: missing JSON delimiters");
        }
        return match[1].trim();
    }

    async _callAI(transcript) {

        const prompt = `
            You are an automated system producing machine-readable output.

            You MUST return exactly ONE JSON object.
            The JSON MUST be enclosed between the delimiters BEGIN_JSON and END_JSON.
            No text is allowed before BEGIN_JSON or after END_JSON.

            The JSON object MUST strictly conform to schema:
            - Name: YouTubeTranscriptAnalysis
            - Version: 1.0
            - additionalProperties: false

            The JSON object MUST contain EXACTLY these fields, with the following meaning:

            - "schema_version":
            string, MUST be exactly "1.0".

            - "title":
            string containing the most likely video title inferred strictly from the transcript.
            Do NOT invent titles unrelated to the transcript.

            - "language":
            string indicating the original language detected in the transcript
            (e.g., "Spanish", "English", "French").

            - "model_used":
            string identifying the model used.

            - "content":
            string containing an exhaustive, structured summary strictly grounded in the transcript.
            Do NOT invent, assume, or add external information. Never use double quotes , use sigle quotes for emphasis.
            Highlight key points, main arguments, and conclusions explicitly stated in the transcript.
            Include only explanations or examples that appear verbatim or are directly paraphrased.
            Use Markdown formatting (headings, bullet lists, bold text) inside the string to improve readability.
            ${OVERRIDE_LANG
                ? `Write in ${OVERRIDE_LANG}.`
                : `Write in the same language as the transcript. Do NOT translate.`}

            Rules:
            - Do NOT include comments.
            - Do NOT include trailing commas.
            - Do NOT wrap the JSON in Markdown or code fences.
            - Do NOT include explanations or extra text.
            - The output MUST be parseable using JSON.parse().
            - If you cannot fully comply, return NOTHING.

            BEGIN_JSON
            {
            "schema_version": "1.0",
            "title": "",
            "language": "",
            "model_used": "deepseek",
            "content": ""
            }
            END_JSON

            TRANSCRIPT:
            ---
            ${transcript}
            ---
            `;


        const { client, model, rawContent } = await this.aiClient.generateContent(prompt);

        const fullContentChunks = await this.buildRawTranscript(transcript) || ""

        return {
            fullContentChunks: fullContentChunks,
            rawContent,
            client,
            model,
        };
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

        } catch (err) {
            console.error(`   ❌ Error processing ${filePath}: ${err.message}`, err);
            await this.moveToError([filePath], err);
        }
    }
}


class InterpretSummaryStage extends BaseStage {
    constructor(logger) {
        super({
            name: 'Interpret Summary',
            inputDir: DIRS.INTERPRET_SUMMARY.INPUT,
            outputDir: DIRS.INTERPRET_SUMMARY.OUTPUT,
            errorDir: DIRS.INTERPRET_SUMMARY.ERROR,
            logger
        });
    }

    extractJsonBlock(raw) {
        if (!raw) return raw;

        const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        return match ? match[1].trim() : raw.trim();
    }

    chunkTranscript(text, maxChars = 8000) {
        const paragraphs = text.split('\n\n');
        const chunks = [];

        let current = '';

        for (const p of paragraphs) {
            const candidate = current
                ? current + '\n\n' + p
                : p;

            if (candidate.length > maxChars) {
                if (current.trim().length > 0) {
                    chunks.push(current.trim());
                }
                current = p;
            } else {
                current = candidate;
            }
        }

        if (current.trim().length > 0) {
            chunks.push(current.trim());
        }

        return chunks;
    }

    buildChunkPrompt(chunk, index, total) {
        return `
            You are an expert Editor and Translator. You are processing PART ${index} of ${total}.

            ### GOAL
            Produce a **clean, native Spanish version** of the text, formatted with Markdown for readability.

            ### CRITICAL RULE: NO INTERLEAVING
            - **NEVER** output the original English text.
            - **NEVER** output "English text (Spanish translation)".
            - **REPLACE** the original text entirely with Spanish.
            - The audience speaks **ONLY SPANISH**.

            ### MARKDOWN FORMATTING RULES (Apply inside the "content" field):
            1. **Paragraphs & Dialogues:** You MUST use double line breaks (\n\n) to visually separate paragraphs and different speakers.
            2. **Emphasis:** Use **bold** (double asterisks) for key terms, emphasized words, or loud speech found in the source.
            3. **Structure:** Do not create big blocks of text. Break it down so it is easy to read.

            ### OUTPUT FORMAT (Strict JSON):
            Return ONLY a single valid JSON object. No code blocks. No intro text.
            Ensure the "content" string is properly escaped for JSON if necessary.

            {
                "chunk_index": ${index},
                "content": "Aquí va la traducción completa en Español formato MARKDOWN MANDATORY.\\n\\nUsa saltos de línea para separar párrafos.\\n\\nUsa **negrita** para resaltar ideas clave."
            }

            ### INPUT TEXT:
            ${chunk}
        `.trim();
    }

    async processChunks(chunks) {
        const results = [];

        for (let i = 0; i < chunks.length; i++) {

            const parsed = JSON5.parse(chunks[i]);

            // console.log(rawContent);

            // console.log(`   Processed chunk ${i + 1}/${chunks.length}: ${parsed.content.substring(0, 120)}.`);

            results.push({
                index: parsed.chunk_index,
                content: parsed.content
            });
        }

        return results;
    }

    assembleFullContent(chunkResults) {
        return chunkResults
            .sort((a, b) => a.index - b.index)
            .map(c => c.content.trim())
            .join('\n\n');
    }

    async buildRawTranscript(rawTranscript) {
        //const normalized = normalizeTranscript(rawTranscript);
        //const withSpeakers = detectSpeakers(normalized);
        const chunks = this.chunkTranscript(rawTranscript);

        const chunkResults = await this.processChunks(chunks);
        const fullContent = this.assembleFullContent(chunkResults);

        //const finalPrompt = buildFinalPrompt(fullContent);
        //const finalResponse = await callLLM(finalPrompt);

        return fullContent; //JSON.parse(finalResponse);
    }

    extractStrict(raw) {
        const match = raw.match(/BEGIN_JSON\s*([\s\S]*?)\s*END_JSON/);
        if (!match) {
            throw new Error("Invalid AI output: missing JSON delimiters");
        }
        return match[1].trim();
    }

    robustSanitize(rawJson) {
        // 1. Identificamos dónde empieza y termina el valor de "content"
        // Buscamos la clave "content": y capturamos todo hasta el final del objeto
        const contentRegex = /("content"\s*:\s*")([\s\S]*?)("\s*\n?\s*})/;

        return rawJson.replace(contentRegex, (match, prefix, content, suffix) => {
            // 2. En el bloque 'content', reemplazamos saltos de línea reales por \n
            const sanitizedContent = content
                .replace(/\r?\n/g, '\\n') // Convierte Enter en la cadena \n
                .replace(/"/g, "'");      // Opcional: cambia comillas dobles internas por simples para evitar cierres prematuros

            return prefix + sanitizedContent + suffix;
        });
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

            // Clean common artifacts (e.g., if model wraps response in ```json ... ```)

            let cleanedJson = this.extractStrict(data.rawContent);

            // console.log(`   Cleaned JSON: ${cleanedJson}`);

            let parsed;

            // --- PASO DE RESCATE ---
            try {
                // Intentamos parsear normal
                parsed = JSON5.parse(cleanedJson);
            } catch (e) {
                console.log(`   ⚠️ JSON corrupto detectado, intentando reparación robusta...`);
                // Si falla, aplicamos la limpieza de saltos de línea internos
                cleanedJson = this.robustSanitize(cleanedJson);
                parsed = JSON5.parse(cleanedJson);
            }

            // console.log(`   Chunks: `, data.fullContentChunks);

            const chunks = await this.processChunks(data.fullContentChunks)

            const fullContent = await this.assembleFullContent(chunks) || ""

            // Create final Markdown content
            const mdContent = `# ${parsed.title}

                ${parsed.content}`;

            // console.log(`   Parsed JSON: `, parsed);

            const enrichedData = {
                ...data,
                title: parsed.title || "Untitled Video",
                language: parsed.language || "Unknown",
                model: parsed.model_used || model,
                summaryBody: parsed.content || "",
                fullContent: fullContent,
                // client,
                markdown: parsed.content || "",
            };

            // console.log(`  assembleFullContent: `, fullContent);

            // --- outputs ---
            const jsonOut = path.join(this.outputDir, `${videoId}.enriched.json`);
            const mdOut = path.join(this.outputDir, `${videoId}.summary.md`);

            await Promise.all([
                fs.writeFile(jsonOut, JSON.stringify(enrichedData, null, 2)),
                fs.writeFile(mdOut, `# ${parsed.title}\n\n${parsed.content}`)
            ]);

            await this.logSuccess([filePath], [jsonOut, mdOut]);

        } catch (err) {
            console.error(`   ❌ Error processing ${filePath}: ${err.message}`, err);
            await this.moveToError([filePath], err);
        }
    }
}

class EmailStage extends BaseStage {
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
            const bodyHtml = marked(enrichedData.markdown);

            // console.log(`   fullContent for: ${enrichedData.fullContent.substring(0, 120)}...`,);
            const fullContentHtml = marked(enrichedData.fullContent + "\n\n");

            // 4) Build HTML Email
            const finalHtml = `
    <!DOCTYPE html>
    <html>
    <head>
    <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; max-width: 800px; margin: auto; }
        .container { background: white; padding: 30px; border-radius: 10px; }
        h1 { color: #333; }
        .header-img { width: 100%; border-radius: 8px; }
        .btn { background: #cc0000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; }
    </style>
    </head>
    <body>
        <div class="container">
            <a href="${videoUrl}">
                <img class="header-img" src="${thumbnailUrl}" />
            </a>

            <h1>${title}</h1>

            <div style="text-align: center; margin-bottom: 20px;">
                <a class="btn" href="${videoUrl}">Watch on YouTube</a>
            </div>

            ${bodyHtml}

            <div style="text-align: left; margin-bottom: 20px;">
                <h2>Contenido completo</h2>
            </div>

            ${fullContentHtml}

            <p style="font-size: 12px; color: #777; margin-top: 40px;">
                Generated automatically — Video ID: ${videoId} Model: ${enrichedData.model || 'N/A'} Client: ${enrichedData.client || 'N/A'}
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

async function moveOutputs(srcDir, destDir, filterFn) {
    const files = await fs.readdir(srcDir);

    for (const f of files.filter(filterFn)) {
        await fs.rename(
            path.join(srcDir, f),
            path.join(destDir, f)
        );
    }
}

// ==========================================================
// MAIN EXECUTION
// ==========================================================

async function main() {
    // 1. Configure AI
    // Options: 'deepseek', 'qwen', 'gemini', 'lmstudio'
    const provider = 'lmstudio';
    const aiClient = createAiClient(provider);

    const logger = new EventLogger();

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
    const explicitDownload = args.includes('--download');
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
    const doDownload = explicitDownload || urlsToProcess.length > 0 || doAll;

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

    // --- SEQUENTIAL EXECUTION ---

    // 1. Stage: Download
    if (doDownload) {
        if (urlsToProcess.length === 0) {
            // Only show error if the user explicitly asked to download but gave no URLs
            // If they just ran --summarize, we skip this warning.
            if (explicitDownload || doAll) {
                console.error("❌ Error: You requested a download (or --all) but provided no URLs via --url.");
            } else {
                console.log("ℹ️ Skipping download stage (no URLs provided).");
            }
        } else {
            console.log(`\n🔵 [STAGE 1] Processing ${urlsToProcess.length} URL(s)...`);
            // Process URLs sequentially to avoid rate limiting or potential overlapping file I/O issues
            for (const url of urlsToProcess) {
                try {
                    await downloader.execute(url);
                } catch (err) {
                    // Error is logged inside the stage
                }
            }
        }
    }

    // 2. Stage: Summarize
    // Note: If --all is present or --summarize is present, we run this.
    if (doSummarize) {
        console.log(`\n🟣 [STAGE 2] Preparing files for summarization...`);

        // download → summarize
        await moveOutputs(
            DIRS.DOWNLOAD.OUTPUT,
            DIRS.AI_SUMMARIZE.INPUT,
            f => f.endsWith('.json')
        );

        console.log(`\n🟣 [STAGE 2A] Searching for files to summarize to: ${DIRS.AI_SUMMARIZE.INPUT}`);

        const aiSummaryInputs = await aiSummarizer.listInputs(f => f.endsWith('.json'));

        if (aiSummaryInputs.length === 0) {
            console.log("⚠️ No pending files to summarize in " + DIRS.AI_SUMMARIZE.INPUT);
        } else {
            console.log(`🟣 [STAGE 2A] Summarizing ${aiSummaryInputs.length} file(s)...`);
            for (const file of aiSummaryInputs) {
                await aiSummarizer.execute(path.join(DIRS.AI_SUMMARIZE.INPUT, file));
            }
        }

        console.log(`\n🟣 [STAGE 2B] Preparing files for interpretation...`);

        // download → summarize
        await moveOutputs(
            DIRS.AI_SUMMARIZE.OUTPUT,
            DIRS.INTERPRET_SUMMARY.INPUT,
            f => f.endsWith('.json')
        );

        console.log(`\n🟣 [STAGE 2B] Searching for files to interpret AI results to: ${DIRS.INTERPRET_SUMMARY.INPUT}`);

        const interpretSummaryInputs = await interpretSummaryStage.listInputs(f => f.endsWith('.json'));

        if (interpretSummaryInputs.length === 0) {
            console.log("⚠️ No pending files to interpret AI results in " + DIRS.INTERPRET_SUMMARY.INPUT);
        } else {
            console.log(`🟣 [STAGE 2B] Interpret summary ${interpretSummaryInputs.length} file(s)...`);
            for (const file of interpretSummaryInputs) {
                await interpretSummaryStage.execute(path.join(DIRS.INTERPRET_SUMMARY.INPUT, file));
            }
        }
    }

    // 3. Stage: Email
    // Note: If --all is present or --email is present, we run this.
    if (doEmail) {
        console.log(`\n🟢 [STAGE 3] Preparing emails...`);

        // summarize → email
        await moveOutputs(
            DIRS.INTERPRET_SUMMARY.OUTPUT,
            DIRS.EMAIL.INPUT,
            f => f.endsWith('.json') || f.endsWith('.md') // anchor rule
        );

        console.log(`\n🟢 [STAGE 3] Searching for summaries to send in: ${DIRS.EMAIL.INPUT}`);

        // We use the .enriched.json as the "anchor" file to trigger the email
        const emailInputs = await emailer.listInputs(f => f.endsWith('.enriched.json'));

        if (emailInputs.length === 0) {
            console.log("⚠️ No pending summaries to email.");
        } else {
            console.log(`🟢 [STAGE 3] Sending ${emailInputs.length} email(s)...`);
            for (const file of emailInputs) {
                const fullPath = path.join(DIRS.EMAIL.INPUT, file);
                await emailer.execute(fullPath);
            }
        }
    }

    // 4. Final Cleanup: Move everything from Email Output to DONE
    if (doAll || doEmail) {
        const emailOutputs = await fs.readdir(DIRS.EMAIL.OUTPUT);
        if (emailOutputs.length > 0) {
            console.log(`\n✅ [FINISH] Cleaning up. Moving files to: ${DIRS.DONE}`);
            
            await moveOutputs(
                DIRS.EMAIL.OUTPUT,
                DIRS.DONE,
                () => true
            );
        }
    }

}

main().catch(console.error);
