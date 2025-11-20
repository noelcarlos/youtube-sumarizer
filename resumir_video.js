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

dotenv.config();

// ==========================================================
// CONFIGURATION (CONSTANTES)
// ==========================================================

// --- PIPELINE DIRECTORIES ---
const BASE_DIR = './pipeline-data';
const DIRS = {
    RAW: path.join(BASE_DIR, '1-transcripts'),      // Input for AI
    SUMMARY: path.join(BASE_DIR, '2-summaries'),        // Input for Email
    DONE_RAW: path.join(BASE_DIR, '3-done', 'raw'),       // Archived raw files
    DONE_SUMMARY: path.join(BASE_DIR, '3-done', 'sent')   // Archived sent files
};

// --- API KEYS ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // REPLACE THIS
const GEMINI_MODEL = "gemini-2.0-flash"; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"; 
const DEEPSEEK_MODEL = "deepseek-chat";

const LMSTUDIO_API_KEY = process.env.LMSTUDIO_API_KEY;
const LMSTUDIO_BASE_URL = "http://localhost:1234/v1"; 
const LMSTUDIO_MODEL_NAME = "openai/gpt-oss-20b"; 
// const LMSTUDIO_MODEL_NAME = "qwen2.5-14b-instruct-mlx"; 
// const LMSTUDIO_MODEL_NAME = "deepseek/deepseek-r1-0528-qwen3-8b"; 
// // "qwen2.5-14b-instruct-mlx"; // "mistralai/mistral-7b-instruct-v0.3"; // "openai/gpt-oss-20b"; // "deepseek-r1-distill-qwen-7b"; 

// --- EMAIL CONFIG ---
const EMAIL_USER = "david.rey.1040@gmail.com";
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = "noel.carlos@gmail.com"; 
const EMAIL_BCC = null; //"kl2053258@gmail.com";


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

// ==========================================================
// SECTION 2: PIPELINE MANAGER
// ==========================================================

class PipelineManager {
    constructor(aiClient) {
        this.aiClient = aiClient;
    }

    // --- UTILITIES ---

    async initDirs() {
        for (const dir of Object.values(DIRS)) {
            await fs.mkdir(dir, { recursive: true });
        }
    }

    extractVideoId(urlString) {
        try {
            const url = new URL(urlString);
            if (url.hostname.includes('youtube.com') && url.searchParams.has('v')) return url.searchParams.get('v');
            if (url.hostname.includes('youtu.be')) return url.pathname.substring(1);
        } catch (e) { return null; }
        return null;
    }

    // --- STAGE 1: DOWNLOAD (YouTube -> JSON in RAW folder) ---

    async stageDownload(url) {
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

            // Save to RAW folder
            const filePath = path.join(DIRS.RAW, `${videoId}.json`);
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            
            console.log(`✅ Saved to: ${filePath}`);
            return videoId; 

        } catch (error) {
            console.error(`❌ Error downloading: ${error.message}`);
        }
    }

    // --- STAGE 2: SUMMARIZE (RAW folder -> MD in SUMMARY folder) ---

    async stageSummarize() {
        console.log(`\n🟣 [STAGE 2] Searching for files to summarize in: ${DIRS.RAW}`);
        
        const files = await fs.readdir(DIRS.RAW);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        if (jsonFiles.length === 0) {
            console.log("⚠️ No pending files to summarize.");
            return;
        }

        for (const file of jsonFiles) {
            const inputPath = path.join(DIRS.RAW, file);
            console.log(`   Processing: ${file}...`);

            try {
                const content = await fs.readFile(inputPath, 'utf-8');
                const data = JSON.parse(content);
                
                // Generate summary
                const { title, language, summaryBody, client, model, rawContent } = await this._callAI(data.transcript);

                data.title = title;
                data.language = language;
                data.markdown = summaryBody;
                data.model = model;
                data.client = client;
                data.summaryDate = new Date().toISOString();
                data.rawContent = rawContent

                // Create final Markdown content
                const mdContent = `# ${title}

${summaryBody}`;

                // Save to SUMMARY folder
                const outputFileName = `${data.videoId}-${data.summaryDate}.md`;
                await fs.writeFile(path.join(DIRS.SUMMARY, outputFileName), mdContent);
                
                await fs.unlink(inputPath);

                // Move original file to DONE_RAW
                await fs.writeFile(path.join(DIRS.DONE_RAW, `${data.videoId}-${data.summaryDate}.json`), JSON.stringify(data, null, 2));

                console.log(`   ✅ Summarized and saved: ${outputFileName}`);

            } catch (error) {
                console.error(`   ❌ Error processing ${file}: ${error.message}`);
            }
        }
    }

    async _callAI(transcript) {
        const prompt = `Analyze the following YouTube transcript and respond EXCLUSIVELY with a valid JSON object—no additional text, explanations, or formatting before or after.
            The JSON must contain EXACTLY these fields:
            - "title": a string with the most likely video title inferred from the transcript.
            - "language": a string indicating the original language detected (e.g., "Spanish", "English", etc.).
            - "model_used": a string (use "deepseek" for this context).
            - "content": a string containing a comprehensive summary in Markdown format (use headings, bullet points, bold text, etc.), written in the same language as the transcript—no translation.

            Strict rules:
            - Do NOT wrap the JSON in code blocks (e.g., no \`\`\`json).
            - Do NOT add comments, prefixes, or suffixes.
            - The output must be parseable with JSON.parse().
            - The "content" field must be a single Markdown-formatted string.

            TRANSCRIPT:
            ---
            ${transcript}
            ---`;

        const { client, model, rawContent } = await this.aiClient.generateContent(prompt);

        // Clean common artifacts (e.g., if model wraps response in ```json ... ```)
        let cleanedJson = rawContent
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*$/gm, '')
            .trim();

        let parsed;
        try {
            parsed = JSON.parse(cleanedJson);
        } catch (e) {
            console.error("❌ Failed to parse AI response as JSON:", cleanedJson);
            // Fallback to avoid crashing
            return {
                title: "Error: Invalid JSON",
                language: "Unknown",
                model: model,
                content: "Error: The AI did not return valid JSON.",
                rawContent,
                client
            };
        }

        return {
            title: parsed.title || "Untitled Video",
            language: parsed.language || "Unknown",
            model: parsed.model_used || model,
            summaryBody: parsed.content || "",
            rawContent,
            client
        };
    }


    async _printToConsole(finalContent) {
        console.log('\n==============================================');
        console.log('               RESUMEN GENERADO (Consola)     ');
        console.log('==============================================');
        console.log(finalContent);
        console.log('==============================================');
    }
    // --- STAGE 3: EMAIL (SUMMARY folder -> Email -> DONE_SUMMARY folder) ---

    // --- STAGE 3: EMAIL (SUMMARY folder -> Email -> Save HTML to DONE) ---

    async stageEmail() {
        console.log(`\n🟠 [STAGE 3] Searching for summaries to send in: ${DIRS.SUMMARY}`);

        const files = await fs.readdir(DIRS.SUMMARY);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        if (mdFiles.length === 0) {
            console.log("⚠️ No summaries pending for email.");
            return;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        for (const file of mdFiles) {
            const filePath = path.join(DIRS.SUMMARY, file);
            const jsonPath = path.join(DIRS.DONE_RAW, file.replace('.md', '.json'));

            console.log(`   Processing: ${file}...`);

            try {
                // 1) Load Markdown Content
                const mdContent = await fs.readFile(filePath, 'utf-8');

                // 2) Load JSON Metadata (title, language, videoId, etc.)
                const jsonExists = await fs.access(jsonPath).then(() => true).catch(() => false);

                if (!jsonExists) {
                    throw new Error(`Missing JSON metadata file: ${jsonPath}`);
                }

                const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));

                const title = jsonData.title || "YouTube Summary";
                const videoId = jsonData.videoId;
                const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

                // 3) Convert Markdown → HTML
                const bodyHtml = marked(jsonData.markdown);

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

            <p style="font-size: 12px; color: #777; margin-top: 40px;">
                Generated automatically — Video ID: ${videoId} Model: ${jsonData.model || 'N/A'} Client: ${jsonData.client || 'N/A'}
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

                // 6) Save email as HTML
                const htmlFilename = file.replace('.md', '.html');
                await fs.writeFile(path.join(DIRS.DONE_SUMMARY, htmlFilename), finalHtml);

                // 7) Move Markdown to DONE folder
                await fs.rename(filePath, path.join(DIRS.DONE_RAW, file));

                console.log(`   ✅ Email sent & saved to DONE: ${htmlFilename}`);

            } catch (error) {
                console.error(`   ❌ Error sending ${file}: ${error.message}`);
            }
        }
    }

}

// ==========================================================
// MAIN EXECUTION
// ==========================================================

// ==========================================================
// MAIN EXECUTION
// ==========================================================

async function main() {
    // 1. Configure AI
    // Options: 'deepseek', 'qwen', 'gemini', 'lmstudio'
    const provider = 'lmstudio'; 
    const aiClient = createAiClient(provider);
    const pipeline = new PipelineManager(aiClient);

    // 2. Initialize directories
    await pipeline.initDirs();

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
                await pipeline.stageDownload(url);
            }
        }
    }

    // 2. Stage: Summarize
    // Note: If --all is present or --summarize is present, we run this.
    if (doSummarize) {
        await pipeline.stageSummarize();
    }

    // 3. Stage: Email
    // Note: If --all is present or --email is present, we run this.
    if (doEmail) {
        await pipeline.stageEmail();
    }
}

main().catch(console.error);