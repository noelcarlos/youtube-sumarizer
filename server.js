// ==========================================================
// SERVIDOR PERSISTENTE — 4 workers de etapa corriendo a la vez
// ==========================================================
//
// resumir_video.js en modo CLI es "un tiro": arranca, procesa lo que hay en las colas
// (carpetas), y sale. Este servidor reutiliza EXACTAMENTE las mismas clases de etapa y el
// mismo runStageWorker, pero en modo daemon: nunca marca upstreamDone, asi que cada worker
// se queda vigilando su carpeta para siempre en vez de salir cuando la ve vacia.
//
// Con esto, encolar un video con el CLI (queue-cli.js) o la UI no dispara un proceso nuevo —
// solo deja un fichero en process-inputs/input, y el worker de descarga que YA esta corriendo
// lo recoge en su siguiente vuelta de sondeo.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';
import nodemailer from 'nodemailer';
import {
    DIRS, initDirs, EventLogger, moveOutputs, runStageWorker, createAiClient, listModels, AI_PROVIDER_DEFAULTS,
    ProcessInputsStage, DownloadStage, AiSummarizeStage, InterpretSummaryStage, EmailStage,
    EMAIL_CONFIG,
} from './resumir_video.js';

// 4173 es el default de iron-agile-bot (server/src/index.js) — con los dos corriendo a la vez
// en la misma maquina, uno de ellos pierde el puerto. 4577 no choca con nada conocido en esta
// maquina; `PORT` en .env lo cambia si hiciera falta.
const PORT = Number(process.env.PORT || 4577);

await initDirs();

// ==========================================================
// SETTINGS — persistidas en disco (pipeline-data/settings.json), igual que el propio estado
// de la cola vive en las carpetas: nada de base de datos aparte. Se cargan ANTES de crear el
// aiClient/EMAIL_CONFIG para que un reinicio del servidor recuerde lo que se configuro desde
// la UI, no solo lo que hay en .env.
// ==========================================================

const SETTINGS_PATH = path.join('pipeline-data', 'settings.json');

const DEFAULT_SETTINGS = {
    llm: {
        provider: process.env.AI_PROVIDER || 'lmstudio',
        overrides: { gemini: {}, deepseek: {}, nvidia: {}, lmstudio: {} },
    },
    email: { to: EMAIL_CONFIG.to, bcc: EMAIL_CONFIG.bcc },
    // Cada etapa pausada por separado: "dame tiempo a configurar otro LLM" solo tiene sentido
    // pausando AI_SUMMARIZE, pero se ofrecen las 4 porque la misma necesidad aplica a cualquier
    // etapa (por ejemplo, pausar EMAIL mientras se cambia el destinatario en este mismo Settings).
    paused: { DOWNLOAD: false, AI_SUMMARIZE: false, INTERPRET_SUMMARY: false, EMAIL: false },
};

async function loadSettings() {
    try {
        const parsed = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
        return {
            llm: {
                provider: parsed.llm?.provider || DEFAULT_SETTINGS.llm.provider,
                overrides: { ...DEFAULT_SETTINGS.llm.overrides, ...parsed.llm?.overrides },
            },
            email: { ...DEFAULT_SETTINGS.email, ...parsed.email },
            paused: { ...DEFAULT_SETTINGS.paused, ...parsed.paused },
        };
    } catch {
        return structuredClone(DEFAULT_SETTINGS);
    }
}

const settings = await loadSettings();
async function persistSettings() {
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// `paused` es el MISMO objeto que settings.paused (no una copia): los workers cierran sobre
// esta referencia, asi que mutar sus propiedades desde /api/settings basta para pausarlos o
// reanudarlos sin tener que volver a arrancar nada.
const paused = settings.paused;

EMAIL_CONFIG.to = settings.email.to;
EMAIL_CONFIG.bcc = settings.email.bcc;

let aiClient = createAiClient(settings.llm.provider, settings.llm.overrides[settings.llm.provider] || {});
const logger = new EventLogger();

const processInputsStage = new ProcessInputsStage(logger);
const downloader = new DownloadStage(logger);
const aiSummarizer = new AiSummarizeStage(aiClient, logger);
const interpretSummaryStage = new InterpretSummaryStage(logger);
const emailer = new EmailStage(logger);

// Nunca se pone a `true`: un daemon no tiene forma de saber "no va a llegar nada mas", asi
// que runStageWorker simplemente sondea para siempre cuando su cola esta vacia.
const NEVER_DONE = { v: false };

// Traspaso inicial de lo que ya hubiera en las carpetas de una sesion anterior del CLI.
await moveOutputs(DIRS.PROCESS_INPUTS.OUTPUT, DIRS.DOWNLOAD.INPUT, f => f.endsWith('.json'));
await moveOutputs(DIRS.DOWNLOAD.OUTPUT, DIRS.AI_SUMMARIZE.INPUT, f => f.endsWith('.json'));
await moveOutputs(DIRS.AI_SUMMARIZE.OUTPUT, DIRS.INTERPRET_SUMMARY.INPUT, f => f.endsWith('.json'));
await moveOutputs(DIRS.INTERPRET_SUMMARY.OUTPUT, DIRS.EMAIL.INPUT, f => f.endsWith('.json') || f.endsWith('.md'));

function startForever(stage, opts) {
    runStageWorker(stage, { ...opts, upstreamDone: NEVER_DONE }).catch(err => {
        // Un worker que muere se queda vigilando nada para siempre: mejor que el proceso entero
        // caiga y se note (por ejemplo, en un `pm2`/systemd que lo reinicie) que un daemon zombi.
        console.error(`💀 worker de "${stage.name}" murio:`, err);
        process.exit(1);
    });
}

startForever(downloader, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.AI_SUMMARIZE.INPUT,
    filterMove: f => f.endsWith('.json'),
    isPaused: () => paused.DOWNLOAD,
});
startForever(aiSummarizer, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
    filterMove: f => f.endsWith('.json'),
    isPaused: () => paused.AI_SUMMARIZE,
});
startForever(interpretSummaryStage, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.EMAIL.INPUT,
    filterMove: f => f.endsWith('.json') || f.endsWith('.md'),
    isPaused: () => paused.INTERPRET_SUMMARY,
});
startForever(emailer, {
    filterInput: f => f.endsWith('.enriched.json'),
    nextInputDir: DIRS.DONE,
    filterMove: () => true,
    isPaused: () => paused.EMAIL,
});

console.log('🟣 4 workers de etapa arrancados (download, ai-summarize, interpret-summary, email)');

/** Vista de /api/settings: nunca devuelve una API key en crudo, solo si hay una configurada
 * (`hasKey`) — la propia o la de .env si Settings no la ha pisado todavia. */
function settingsView() {
    const providers = {};
    for (const [prov, def] of Object.entries(AI_PROVIDER_DEFAULTS)) {
        const ov = settings.llm.overrides[prov] || {};
        providers[prov] = {
            model: ov.model || def.model,
            baseUrl: ov.baseUrl ?? def.baseUrl,
            hasKey: Boolean(ov.apiKey) || def.hasKey,
        };
    }
    return {
        llm: { provider: settings.llm.provider, providers },
        email: settings.email,
        paused: settings.paused,
    };
}

/** POST /api/settings solo manda lo que cambio, no el objeto entero — por eso es un merge
 * campo a campo y no un reemplazo. Si toca provider/overrides del LLM, reconstruye el aiClient
 * y lo reasigna a aiSummarizer.aiClient EN CALIENTE: el worker no se reinicia, la siguiente vez
 * que recoja un video ya usa el cliente nuevo. */
async function applySettingsPatch(body) {
    if (body.llm) {
        if (body.llm.provider) settings.llm.provider = body.llm.provider;
        if (body.llm.overrides) {
            for (const [prov, ov] of Object.entries(body.llm.overrides)) {
                settings.llm.overrides[prov] = { ...settings.llm.overrides[prov], ...ov };
            }
        }
        aiClient = createAiClient(settings.llm.provider, settings.llm.overrides[settings.llm.provider] || {});
        aiSummarizer.aiClient = aiClient;
    }
    if (body.email) Object.assign(settings.email, body.email);
    if (body.email?.to !== undefined) EMAIL_CONFIG.to = settings.email.to;
    if (body.email?.bcc !== undefined) EMAIL_CONFIG.bcc = settings.email.bcc;
    if (body.paused) Object.assign(paused, body.paused);

    await persistSettings();
    return settingsView();
}

// ==========================================================
// ESTADO DE LA COLA — se deriva en vivo de las carpetas, no de una base de datos aparte.
// La carpeta en la que esta un fichero YA ES su estado; duplicarlo en otro sitio es una
// fuente de verdad extra que se puede desincronizar.
// ==========================================================

const STAGE_ORDER = ['PROCESS_INPUTS', 'DOWNLOAD', 'AI_SUMMARIZE', 'INTERPRET_SUMMARY', 'EMAIL', 'DONE'];
const STAGE_LABEL = {
    PROCESS_INPUTS: 'Encolado',
    DOWNLOAD: 'Descargando',
    AI_SUMMARIZE: 'Resumiendo (IA)',
    INTERPRET_SUMMARY: 'Interpretando',
    EMAIL: 'Enviando email',
    DONE: 'Terminado',
};

async function listDir(dir) {
    try { return await fs.readdir(dir); } catch { return []; }
}

/** El nombre de fichero de cada etapa lleva sufijos distintos (`.ai.raw.json`, `.enriched.json`,
 * `.summary.md`, `.email.html`) — esto los reduce todos al videoId desnudo para poder agrupar. */
function videoIdFromFilename(filename) {
    return filename
        .replace(/\.ai\.raw\.json$/i, '')
        .replace(/\.enriched\.json$/i, '')
        .replace(/\.summary\.md$/i, '')
        .replace(/\.email\.html$/i, '')
        .replace(/\.json$/i, '');
}

async function buildState() {
    const byVideo = new Map();

    const record = (videoId, stageName, bucket, filename) => {
        if (!byVideo.has(videoId)) byVideo.set(videoId, { videoId, stage: stageName, bucket, files: [] });
        const v = byVideo.get(videoId);
        // Se recorre en orden de avance del pipeline, asi que la ultima vez que se ve un
        // videoId es su etapa MAS AVANZADA — es justo lo que queremos mostrar.
        v.stage = stageName;
        v.bucket = bucket;
        v.files.push(filename);
    };

    for (const stageName of STAGE_ORDER) {
        if (stageName === 'DONE') continue;
        const dirs = DIRS[stageName];
        for (const bucket of ['INPUT', 'OUTPUT', 'ERROR']) {
            const dirPath = dirs[bucket];
            if (!dirPath) continue;
            for (const f of await listDir(dirPath)) record(videoIdFromFilename(f), stageName, bucket.toLowerCase(), f);
        }
    }
    for (const f of await listDir(DIRS.DONE)) record(videoIdFromFilename(f), 'DONE', 'output', f);

    return [...byVideo.values()];
}

/** Rellena titulo/idioma/modelo/url en cuanto existan — aparecen en cuanto termina 2A o 2B,
 * asi que antes de eso el video solo se ve por su id. */
async function enrichVideo(v) {
    const candidates = [
        path.join(DIRS.DONE, `${v.videoId}.enriched.json`),
        path.join(DIRS.EMAIL.OUTPUT, `${v.videoId}.enriched.json`),
        path.join(DIRS.EMAIL.INPUT, `${v.videoId}.enriched.json`),
        path.join(DIRS.INTERPRET_SUMMARY.OUTPUT, `${v.videoId}.enriched.json`),
        path.join(DIRS.INTERPRET_SUMMARY.INPUT, `${v.videoId}.ai.raw.json`),
        path.join(DIRS.AI_SUMMARIZE.OUTPUT, `${v.videoId}.ai.raw.json`),
        // Estos ultimos no tienen title/language (aun no ha pasado por el modelo), pero SI tienen
        // `url` desde el principio — es el job normalizado que genero ProcessInputsStage. Sin esto,
        // un video que falla en la descarga (antes de que exista ningun .ai.raw.json) se queda sin
        // URL en la UI, que es justo el caso en el que mas hace falta poder pinchar en el enlace.
        path.join(DIRS.AI_SUMMARIZE.INPUT, `${v.videoId}.json`),
        path.join(DIRS.AI_SUMMARIZE.ERROR, `${v.videoId}.json`),
        path.join(DIRS.DOWNLOAD.INPUT, `${v.videoId}.json`),
        path.join(DIRS.DOWNLOAD.ERROR, `${v.videoId}.json`),
    ];
    for (const p of candidates) {
        try {
            const data = JSON.parse(await fs.readFile(p, 'utf8'));
            return {
                ...v,
                stageLabel: STAGE_LABEL[v.stage] || v.stage,
                title: data.title || null,
                language: data.language || null,
                model: data.model || null,
                url: data.url || null,
            };
        } catch { /* ese candidato no existe o no es JSON — se prueba el siguiente */ }
    }
    return { ...v, stageLabel: STAGE_LABEL[v.stage] || v.stage, title: null, language: null, model: null, url: null };
}

/** Ultimo error registrado para este video en events.log, si lo hay — para que el fallo se
 * pueda leer desde la UI sin tener que ir a la terminal. */
async function lastErrorFor(videoId) {
    let raw;
    try { raw = await fs.readFile(path.join(DIRS.EVENTS, 'events.log'), 'utf8'); } catch { return null; }
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        let event;
        try { event = JSON.parse(lines[i]); } catch { continue; }
        if (event.status !== 'ERROR') continue;
        const touchesThisVideo = (event.inputs || []).some(f => videoIdFromFilename(f) === videoId);
        if (touchesThisVideo) return { stage: event.stage, error: event.error, at: event.timestamp };
    }
    return null;
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

/** Mismo sistema de diseño 2026 que la plantilla de email (ver EmailStage en resumir_video.js) —
 * se pidio unificar el .md y el email en un solo look, asi que comparten paleta y tipografia:
 * Inter para texto, JetBrains Mono para el link/metadata, H1 30px/bold, H2 20px/semibold, p con
 * line-height 28px en zinc-700. Sin boton rojo: el enlace a YouTube es un link mono sutil arriba. */
function readerPage(videoId, bodyHtml, videoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${videoId}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  body {
    margin: 0; padding: 48px 20px; background: #FAFAFA;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    color: #3F3F46;
  }
  .page { max-width: 680px; margin: 0 auto; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .yt-link { display: inline-block; margin-bottom: 20px; font-size: 13px; color: #71717A; text-decoration: none; }
  .yt-link:hover { color: #18181B; }
  h1 { font-size: 30px; font-weight: 700; letter-spacing: -0.01em; color: #18181B; margin: 0 0 8px; }
  h2 { font-size: 20px; font-weight: 600; color: #18181B; margin: 32px 0 12px; }
  p { font-size: 16px; line-height: 28px; color: #3F3F46; margin: 0 0 16px; }
  ul, ol { padding-left: 22px; margin: 0 0 16px; }
  li { font-size: 16px; line-height: 28px; color: #3F3F46; margin-bottom: 4px; }
  a { color: #18181B; }
  strong { color: #18181B; font-weight: 600; }
  img { display: block; max-width: 100%; border: 1px solid #E4E4E7; border-radius: 12px; padding: 8px; background: #FFFFFF; margin: 8px 0 16px; }
  @media (max-width: 480px) { body { padding: 24px 16px; } h1 { font-size: 24px; } }
</style>
</head>
<body>
  <div class="page">
    <a class="yt-link mono" href="${videoUrl}">Ver en YouTube →</a>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// Ya no hay nada que servir aqui: server.js paso de ser API+estaticos a ser solo API+workers
// del pipeline. La UI la sirve Next.js en su propio proceso/puerto (web/), que le hace proxy a
// /api/* de aqui via next.config.js#rewrites — el mismo patron que ya usaba el proxy de Vite en
// dev, pero funcionando tambien en produccion.

async function readFirstExisting(paths) {
    for (const p of paths) {
        try { return await fs.readFile(p, 'utf8'); } catch { /* siguiente candidato */ }
    }
    return null;
}

/** Mueve de vuelta a input/ los ficheros de un video que estan en error/ para su etapa actual —
 * exactamente lo mismo que se ha hecho a mano toda la sesion (mv error/x.json input/x.json), pero
 * desde la UI. El worker de esa etapa ya esta corriendo y lo recoge solo en su siguiente sondeo. */
async function requeueVideo(videoId) {
    const state = await buildState();
    const v = state.find(x => x.videoId === videoId);
    if (!v) throw Object.assign(new Error(`no se encuentra ${videoId} en ninguna cola`), { status: 404 });
    if (v.bucket !== 'error') throw Object.assign(new Error(`${videoId} no esta en error (esta en ${v.stage}/${v.bucket})`), { status: 409 });

    const dirs = DIRS[v.stage];
    const files = (await listDir(dirs.ERROR)).filter(f => videoIdFromFilename(f) === videoId);
    await Promise.all(files.map(f => fs.rename(path.join(dirs.ERROR, f), path.join(dirs.INPUT, f))));
    return { stage: v.stage, files };
}

/** Borra definitivamente un video que esta en error/ — para lo que reencolar no va a arreglar
 * nunca (un video privado, borrado, o con la region bloqueada en YouTube: yt-dlp va a fallar
 * exactamente igual la proxima vez). Solo se puede borrar desde error/, la misma cautela que
 * requeueVideo: nunca se toca un video que este en curso o ya terminado. */
async function deleteVideo(videoId) {
    const state = await buildState();
    const v = state.find(x => x.videoId === videoId);
    if (!v) throw Object.assign(new Error(`no se encuentra ${videoId} en ninguna cola`), { status: 404 });
    if (v.bucket !== 'error') throw Object.assign(new Error(`${videoId} no esta en error (esta en ${v.stage}/${v.bucket}) — no se puede borrar desde aqui`), { status: 409 });

    const dirs = DIRS[v.stage];
    const files = (await listDir(dirs.ERROR)).filter(f => videoIdFromFilename(f) === videoId);
    await Promise.all(files.map(f => fs.unlink(path.join(dirs.ERROR, f))));
    return { stage: v.stage, files };
}

const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
});

/** Botón "Enviar email" del drawer: reenvía el `.email.html` YA generado, tal cual, sin
 * reconstruirlo — el pipeline ya hizo ese trabajo una vez; esto solo repite el envío (por ejemplo,
 * si se perdió o el destinatario lo borró por error). */
async function resendEmail(videoId) {
    const html = await readFirstExisting([
        path.join(DIRS.DONE, `${videoId}.email.html`),
        path.join(DIRS.EMAIL.OUTPUT, `${videoId}.email.html`),
    ]);
    if (html === null) {
        throw Object.assign(new Error(`${videoId} no tiene un email.html generado todavia`), { status: 404 });
    }
    const titleMatch = html.match(/<title>([^<]*)<\/title>|<h1>([^<]*)<\/h1>/i);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2]) : videoId;
    await emailTransporter.sendMail({
        from: EMAIL_CONFIG.user,
        to: EMAIL_CONFIG.to,
        bcc: EMAIL_CONFIG.bcc,
        subject: `[SUMMARY] ${title}`,
        html,
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);

        if (req.method === 'GET' && url.pathname === '/api/settings') {
            return sendJson(res, 200, settingsView());
        }

        if (req.method === 'POST' && url.pathname === '/api/settings') {
            let body = '';
            for await (const chunk of req) body += chunk;
            let parsed;
            try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
            try {
                const view = await applySettingsPatch(parsed);
                return sendJson(res, 200, view);
            } catch (err) {
                // createAiClient lanza si el proveedor elegido no tiene API key todavia (por
                // ejemplo, se cambio a "gemini" pero aun no se ha escrito la key) — 400, no 500,
                // porque es un dato de entrada invalido, no un fallo del servidor.
                return sendJson(res, 400, { error: err.message });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/settings/models') {
            let body = '';
            for await (const chunk of req) body += chunk;
            let parsed;
            try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
            const provider = parsed.provider;
            if (!provider) return sendJson(res, 400, { error: 'falta "provider"' });
            try {
                // Si el usuario todavia no escribio una key/URL nueva en el formulario, se
                // prueba con la ya guardada en Settings — asi el combo funciona tanto para
                // "quiero ver los modelos de lo que ya tengo configurado" como para "acabo de
                // pegar una key nueva, a ver que modelos trae".
                const saved = settings.llm.overrides[provider] || {};
                const overrides = {
                    apiKey: parsed.apiKey || saved.apiKey,
                    baseUrl: parsed.baseUrl || saved.baseUrl,
                };
                const models = await listModels(provider, overrides);
                return sendJson(res, 200, { models });
            } catch (err) {
                return sendJson(res, 400, { error: err.message });
            }
        }

        if (req.method === 'GET' && url.pathname === '/api/state') {
            const state = await buildState();
            const enriched = await Promise.all(state.map(async (v) => {
                const e = await enrichVideo(v);
                if (v.bucket === 'error') e.lastError = await lastErrorFor(v.videoId);
                return e;
            }));
            enriched.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.videoId.localeCompare(b.videoId));
            return sendJson(res, 200, enriched);
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/videos/')) {
            const parts = url.pathname.split('/'); // ['', 'api', 'videos', ':id', ':kind']
            const videoId = parts[3];
            const kind = parts[4];

            if (kind === 'data') {
                // Todo lo que necesita el drawer de lectura en una sola llamada: el resumen corto
                // (pestana "Resumen"), la reescritura fiel completa (pestana "Transcripcion"), el
                // email tal cual se envio, y el .md crudo — sin renderizar nada aqui, eso lo hace
                // react-markdown en el cliente para poder montar las 4 pestanas sin 4 peticiones.
                const enrichedRaw = await readFirstExisting([
                    path.join(DIRS.DONE, `${videoId}.enriched.json`),
                    path.join(DIRS.EMAIL.OUTPUT, `${videoId}.enriched.json`),
                    path.join(DIRS.EMAIL.INPUT, `${videoId}.enriched.json`),
                    path.join(DIRS.INTERPRET_SUMMARY.OUTPUT, `${videoId}.enriched.json`),
                ]);
                if (enrichedRaw === null) { res.writeHead(404).end('enriched.json no encontrado todavia'); return; }
                const enriched = JSON.parse(enrichedRaw);
                const emailHtml = await readFirstExisting([
                    path.join(DIRS.DONE, `${videoId}.email.html`),
                    path.join(DIRS.EMAIL.OUTPUT, `${videoId}.email.html`),
                ]);
                return sendJson(res, 200, {
                    videoId,
                    url: enriched.url || `https://www.youtube.com/watch?v=${videoId}`,
                    title: enriched.title || null,
                    language: enriched.language || null,
                    model: enriched.model || null,
                    summaryBody: enriched.summaryBody || '',
                    fullContent: enriched.fullContent || '',
                    markdown: enriched.markdown || '',
                    emailHtml, // null si aun no se ha enviado
                });
            }

            if (kind === 'reader') {
                const md = await readFirstExisting([
                    path.join(DIRS.DONE, `${videoId}.summary.md`),
                    path.join(DIRS.EMAIL.OUTPUT, `${videoId}.summary.md`),
                    path.join(DIRS.EMAIL.INPUT, `${videoId}.summary.md`),
                ]);
                if (md === null) { res.writeHead(404).end('summary.md no encontrado todavia'); return; }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(readerPage(videoId, marked(md), `https://www.youtube.com/watch?v=${videoId}`));
                return;
            }

            if (kind === 'email') {
                const html = await readFirstExisting([
                    path.join(DIRS.DONE, `${videoId}.email.html`),
                    path.join(DIRS.EMAIL.OUTPUT, `${videoId}.email.html`),
                ]);
                if (html === null) { res.writeHead(404).end('email.html no encontrado todavia (aun no se ha enviado)'); return; }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }

            if (kind === 'markdown') {
                const md = await readFirstExisting([
                    path.join(DIRS.DONE, `${videoId}.summary.md`),
                    path.join(DIRS.EMAIL.OUTPUT, `${videoId}.summary.md`),
                    path.join(DIRS.EMAIL.INPUT, `${videoId}.summary.md`),
                ]);
                if (md === null) { res.writeHead(404).end('summary.md no encontrado todavia'); return; }
                res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
                res.end(md);
                return;
            }

            res.writeHead(404).end('kind desconocido: usa data, reader, email o markdown');
            return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/videos/') && url.pathname.endsWith('/requeue')) {
            const videoId = url.pathname.split('/')[3];
            try {
                const result = await requeueVideo(videoId);
                return sendJson(res, 200, { requeued: videoId, ...result });
            } catch (err) {
                return sendJson(res, err.status || 500, { error: err.message });
            }
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/videos/') && url.pathname.endsWith('/resend')) {
            const videoId = url.pathname.split('/')[3];
            try {
                await resendEmail(videoId);
                return sendJson(res, 200, { resent: videoId });
            } catch (err) {
                return sendJson(res, err.status || 500, { error: err.message });
            }
        }

        if (req.method === 'DELETE' && url.pathname.startsWith('/api/videos/')) {
            const videoId = url.pathname.split('/')[3];
            try {
                const result = await deleteVideo(videoId);
                return sendJson(res, 200, { deleted: videoId, ...result });
            } catch (err) {
                return sendJson(res, err.status || 500, { error: err.message });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/enqueue') {
            let body = '';
            for await (const chunk of req) body += chunk;
            let parsed;
            try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
            const urls = (Array.isArray(parsed.urls) ? parsed.urls : [parsed.url]).filter(Boolean);
            if (urls.length === 0) return sendJson(res, 400, { error: 'falta "url" o "urls"' });

            const count = await processInputsStage.execute(urls);
            // El worker de descarga YA esta corriendo y vigilando esta misma carpeta —
            // no hace falta arrancar ni avisar a nada, la siguiente vuelta de sondeo lo recoge.
            await moveOutputs(DIRS.PROCESS_INPUTS.OUTPUT, DIRS.DOWNLOAD.INPUT, f => f.endsWith('.json'));
            return sendJson(res, 200, { enqueued: count, urls });
        }

        res.writeHead(404).end('not found');
    } catch (err) {
        console.error('❌ error en el servidor:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
});

// 127.0.0.1, NO el wildcard: iron-agile-bot pisaba justo este puerto porque un `node server.js`
// de otro proyecto (este mismo, antes de este fix) escuchaba en *:4173 por IPv6 mientras el suyo
// escuchaba en 127.0.0.1 — su propio vite.config.js documenta el incidente. Escuchar solo en
// 127.0.0.1 evita que este servidor le pueda hacer lo mismo a nadie mas.
server.listen(PORT, '127.0.0.1', () => {
    console.log(`🟢 API + workers del pipeline escuchando en http://localhost:${PORT} (la UI la sirve Next.js aparte, en web/)`);
});
