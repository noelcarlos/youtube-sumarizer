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
import {
    DIRS, initDirs, EventLogger, moveOutputs, runStageWorker, createAiClient,
    ProcessInputsStage, DownloadStage, AiSummarizeStage, InterpretSummaryStage, EmailStage,
} from './resumir_video.js';

// 4173 es el default de iron-agile-bot (server/src/index.js) — con los dos corriendo a la vez
// en la misma maquina, uno de ellos pierde el puerto. 4577 no choca con nada conocido en esta
// maquina; `PORT` en .env lo cambia si hiciera falta.
const PORT = Number(process.env.PORT || 4577);

await initDirs();

const provider = process.env.AI_PROVIDER || 'lmstudio';
const aiClient = createAiClient(provider);
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
});
startForever(aiSummarizer, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
    filterMove: f => f.endsWith('.json'),
});
startForever(interpretSummaryStage, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.EMAIL.INPUT,
    filterMove: f => f.endsWith('.json') || f.endsWith('.md'),
});
startForever(emailer, {
    filterInput: f => f.endsWith('.enriched.json'),
    nextInputDir: DIRS.DONE,
    filterMove: () => true,
});

console.log('🟣 4 workers de etapa arrancados (download, ai-summarize, interpret-summary, email)');

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

function readerPage(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3 { line-height: 1.3; }
  a { color: #cc0000; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

const WEB_DIST = new URL('./web/dist/', import.meta.url);
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
};

/** Sirve `web/dist` (el build de Vite). Sin rutas dentro de la app (no hay react-router, es una
 * sola pagina), asi que cualquier GET que no sea un fichero real cae al index.html del build —
 * y si NO hay build todavia (no se ha corrido `npm run build` en web/), dice exactamente eso en
 * vez de un 404 mudo. Devuelve `false` si no pudo servir nada (para que el caller decida el 404). */
async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = new URL(rel, WEB_DIST);

    let filePath = candidate;
    let data;
    try {
        data = await fs.readFile(candidate);
    } catch {
        // no es un fichero real (o no existe): probamos con el index.html del build para SPA
        try {
            filePath = new URL('index.html', WEB_DIST);
            data = await fs.readFile(filePath);
        } catch {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('web/dist no existe todavia. Corre "npm run build" (o "npm run dev" en web/ para desarrollo).');
            return true;
        }
    }

    const ext = path.extname(filePath.pathname);
    const isIndexHtml = filePath.pathname.endsWith('/index.html');
    // index.html cambia de contenido en cada build SIN cambiar de nombre (referencia los assets
    // por su nombre con hash), asi que si el navegador lo cachea, se queda mirando para siempre
    // los assets de un build viejo aunque haya uno nuevo en disco - exactamente lo que paso aqui.
    // Los assets con hash (index-XXXX.js/.css) si son seguros de cachear fuerte: si cambia el
    // contenido, cambia el nombre del fichero.
    const cacheControl = isIndexHtml ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(data);
    return true;
}

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

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);

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

            if (kind === 'reader') {
                const md = await readFirstExisting([
                    path.join(DIRS.DONE, `${videoId}.summary.md`),
                    path.join(DIRS.EMAIL.OUTPUT, `${videoId}.summary.md`),
                    path.join(DIRS.EMAIL.INPUT, `${videoId}.summary.md`),
                ]);
                if (md === null) { res.writeHead(404).end('summary.md no encontrado todavia'); return; }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(readerPage(videoId, marked(md)));
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

            res.writeHead(404).end('kind desconocido: usa reader, email o markdown');
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

        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
            // Sirve el build de React (web/dist, generado por `npm run build` en web/). En dev,
            // el frontend corre aparte con `vite` (web/dev) y su proxy manda /api aqui — esta
            // rama solo se usa en produccion, cuando server.js sirve los estaticos ya construidos.
            const served = await serveStatic(res, url.pathname);
            if (served) return;
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
    console.log(`🟢 youtube-sumarizer server escuchando en http://localhost:${PORT}`);
});
