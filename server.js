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
    DIRS, initDirs, EventLogger, moveOutputs, fanOutOutputs, runStageWorker, createAiClient, listModels, AI_PROVIDER_DEFAULTS,
    ProcessInputsStage, DownloadStage, SummarizeStage, RewriteStage, InterpretSummaryStage, EmailStage,
    EMAIL_CONFIG, setLocalMutexEnabled, parseSummaryOutput, buildEmailHtml,
} from './resumir_video.js';

// 4173 es el default de iron-agile-bot (server/src/index.js) — con los dos corriendo a la vez
// en la misma maquina, uno de ellos pierde el puerto. 4577 no choca con nada conocido en esta
// maquina; `PORT` en .env lo cambia si hiciera falta.
const PORT = Number(process.env.PORT || 4577);

// Autentica a agent.mjs contra /api/agent/* -- ver resumir_video.js para el porque del modo
// agente en si (PO Token y cookies no bastaron contra el bloqueo de YouTube por IP).
const AGENT_TOKEN = process.env.AGENT_TOKEN;

await initDirs();

// ==========================================================
// SETTINGS — persistidas en disco (pipeline-data/settings.json), igual que el propio estado
// de la cola vive en las carpetas: nada de base de datos aparte. Se cargan ANTES de crear el
// aiClient/EMAIL_CONFIG para que un reinicio del servidor recuerde lo que se configuro desde
// la UI, no solo lo que hay en .env.
// ==========================================================

const SETTINGS_PATH = path.join('pipeline-data', 'settings.json');

// llm.summarize y llm.rewrite son independientes a proposito — dos etapas que corren en
// paralelo con su propio modelo cada una (un modelo grande/lento para el resumen, uno chico/
// rapido para la reescritura, o al reves, lo que se necesite).
function defaultLlmStageConfig() {
    return {
        provider: process.env.AI_PROVIDER || 'lmstudio',
        overrides: { gemini: {}, deepseek: {}, nvidia: {}, lmstudio: {} },
    };
}

const DEFAULT_SETTINGS = {
    llm: {
        summarize: defaultLlmStageConfig(),
        rewrite: defaultLlmStageConfig(),
    },
    email: { to: EMAIL_CONFIG.to, bcc: EMAIL_CONFIG.bcc },
    // Cada etapa pausada por separado: "dame tiempo a configurar otro LLM" solo tiene sentido
    // pausando la etapa que lo usa, pero se ofrecen las 5 porque la misma necesidad aplica a
    // cualquier etapa (por ejemplo, pausar EMAIL mientras se cambia el destinatario aqui mismo).
    paused: { DOWNLOAD: false, SUMMARIZE: false, REWRITE: false, INTERPRET_SUMMARY: false, EMAIL: false },
    // false = serializar (default seguro): un modelo local grande se atasca o tarda mucho mas si
    // Summarize y Rewrite le mandan inferencia a la vez. Un modelo pequeño puede tener margen de
    // sobra para las dos en paralelo sin degradarse — quien sepa que su modelo aguanta eso puede
    // encenderlo desde Settings > Colas.
    parallelLocalInference: false,
};

function mergeLlmStageConfig(parsed) {
    return {
        provider: parsed?.provider || DEFAULT_SETTINGS.llm.summarize.provider,
        overrides: { ...DEFAULT_SETTINGS.llm.summarize.overrides, ...parsed?.overrides },
    };
}

async function loadSettings() {
    try {
        const parsed = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
        return {
            llm: {
                summarize: mergeLlmStageConfig(parsed.llm?.summarize),
                rewrite: mergeLlmStageConfig(parsed.llm?.rewrite),
            },
            email: { ...DEFAULT_SETTINGS.email, ...parsed.email },
            paused: { ...DEFAULT_SETTINGS.paused, ...parsed.paused },
            parallelLocalInference: parsed.parallelLocalInference ?? DEFAULT_SETTINGS.parallelLocalInference,
        };
    } catch {
        return structuredClone(DEFAULT_SETTINGS);
    }
}

const settings = await loadSettings();
setLocalMutexEnabled(settings.parallelLocalInference);
async function persistSettings() {
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ==========================================================
// "LEIDO" — flag manual por video, para simular haber abierto el resumen en la web sin tener
// que abrirlo de verdad. Vive en su propio fichero (no dentro de settings.json) porque es
// metadata POR VIDEO que puede crecer a cientos de entradas, no configuracion global — mismo
// principio de "el estado vive en disco, no en una base de datos aparte" que ya usa todo lo
// demas. { [videoId]: "<ISO timestamp de cuando se marco>" } — ausente = no leido.
// ==========================================================

const READ_STATUS_PATH = path.join('pipeline-data', 'read-status.json');

async function loadReadStatus() {
    try {
        return JSON.parse(await fs.readFile(READ_STATUS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

const readStatus = await loadReadStatus();
async function persistReadStatus() {
    await fs.writeFile(READ_STATUS_PATH, JSON.stringify(readStatus, null, 2));
}

// `paused` es el MISMO objeto que settings.paused (no una copia): los workers cierran sobre
// esta referencia, asi que mutar sus propiedades desde /api/settings basta para pausarlos o
// reanudarlos sin tener que volver a arrancar nada.
const paused = settings.paused;

EMAIL_CONFIG.to = settings.email.to;
EMAIL_CONFIG.bcc = settings.email.bcc;

function buildAiClientFor(stageKey) {
    const cfg = settings.llm[stageKey];
    return createAiClient(cfg.provider, cfg.overrides[cfg.provider] || {});
}

let summarizeAiClient = buildAiClientFor('summarize');
let rewriteAiClient = buildAiClientFor('rewrite');
const logger = new EventLogger();

const processInputsStage = new ProcessInputsStage(logger);
const downloader = new DownloadStage(logger);
const summarizer = new SummarizeStage(summarizeAiClient, logger);
const rewriter = new RewriteStage(rewriteAiClient, logger);
const interpretSummaryStage = new InterpretSummaryStage(logger);
const emailer = new EmailStage(logger);

// Nunca se pone a `true`: un daemon no tiene forma de saber "no va a llegar nada mas", asi
// que runStageWorker simplemente sondea para siempre cuando su cola esta vacia.
const NEVER_DONE = { v: false };

/** El fichero que dispara InterpretSummary es SIEMPRE el .rewrite-part.json — solo cuenta como
 * "listo" cuando su hermano .summary-part.json YA existe en la misma carpeta (las dos etapas
 * corren en paralelo, cada una a su ritmo). El tercer argumento de un callback de .filter() es
 * el array completo, asi no hace falta releer el directorio a mano por cada fichero. */
function interpretJoinFilter(f, _i, allFiles) {
    if (!f.endsWith('.rewrite-part.json')) return false;
    const videoId = f.slice(0, -'.rewrite-part.json'.length);
    return allFiles.includes(`${videoId}.summary-part.json`);
}

// Traspaso inicial de lo que ya hubiera en las carpetas de una sesion anterior.
await moveOutputs(DIRS.PROCESS_INPUTS.OUTPUT, DIRS.DOWNLOAD.INPUT, f => f.endsWith('.json'));
await fanOutOutputs(DIRS.DOWNLOAD.OUTPUT, [DIRS.SUMMARIZE.INPUT, DIRS.REWRITE.INPUT], f => f.endsWith('.json'));
await moveOutputs(DIRS.SUMMARIZE.OUTPUT, DIRS.INTERPRET_SUMMARY.INPUT, f => f.endsWith('.summary-part.json'));
await moveOutputs(DIRS.REWRITE.OUTPUT, DIRS.INTERPRET_SUMMARY.INPUT, f => f.endsWith('.rewrite-part.json'));
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
    nextInputDirs: [DIRS.SUMMARIZE.INPUT, DIRS.REWRITE.INPUT],
    filterMove: f => f.endsWith('.json'),
    isPaused: () => paused.DOWNLOAD,
});
startForever(summarizer, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
    filterMove: f => f.endsWith('.summary-part.json'),
    isPaused: () => paused.SUMMARIZE,
});
startForever(rewriter, {
    filterInput: f => f.endsWith('.json'),
    nextInputDir: DIRS.INTERPRET_SUMMARY.INPUT,
    filterMove: f => f.endsWith('.rewrite-part.json'),
    isPaused: () => paused.REWRITE,
});
startForever(interpretSummaryStage, {
    filterInput: interpretJoinFilter,
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

console.log('🟣 5 workers de etapa arrancados (download, summarize, rewrite, interpret-summary, email) — summarize y rewrite corren en paralelo');

function llmStageView(stageKey) {
    const cfg = settings.llm[stageKey];
    const providers = {};
    for (const [prov, def] of Object.entries(AI_PROVIDER_DEFAULTS)) {
        const ov = cfg.overrides[prov] || {};
        providers[prov] = {
            model: ov.model || def.model,
            baseUrl: ov.baseUrl ?? def.baseUrl,
            hasKey: Boolean(ov.apiKey) || def.hasKey,
        };
    }
    return { provider: cfg.provider, providers };
}

/** Vista de /api/settings: nunca devuelve una API key en crudo, solo si hay una configurada
 * (`hasKey`) — la propia o la de .env si Settings no la ha pisado todavia. summarize y rewrite
 * son independientes: cada uno puede estar en un proveedor/modelo distinto. */
function settingsView() {
    return {
        llm: {
            summarize: llmStageView('summarize'),
            rewrite: llmStageView('rewrite'),
        },
        email: settings.email,
        paused: settings.paused,
        parallelLocalInference: settings.parallelLocalInference,
    };
}

/** POST /api/settings solo manda lo que cambio, no el objeto entero — por eso es un merge
 * campo a campo y no un reemplazo. body.llm.summarize / body.llm.rewrite se procesan cada uno
 * por separado — si toca provider/overrides de UNO, reconstruye SOLO ese aiClient y lo reasigna
 * en caliente (summarizer.aiClient o rewriter.aiClient): el worker no se reinicia, la siguiente
 * vez que recoja un video ya usa el cliente nuevo, sin afectar a la otra etapa. */
async function applySettingsPatch(body) {
    if (body.llm?.summarize) {
        const patch = body.llm.summarize;
        if (patch.provider) settings.llm.summarize.provider = patch.provider;
        if (patch.overrides) {
            for (const [prov, ov] of Object.entries(patch.overrides)) {
                settings.llm.summarize.overrides[prov] = { ...settings.llm.summarize.overrides[prov], ...ov };
            }
        }
        summarizeAiClient = buildAiClientFor('summarize');
        summarizer.aiClient = summarizeAiClient;
    }
    if (body.llm?.rewrite) {
        const patch = body.llm.rewrite;
        if (patch.provider) settings.llm.rewrite.provider = patch.provider;
        if (patch.overrides) {
            for (const [prov, ov] of Object.entries(patch.overrides)) {
                settings.llm.rewrite.overrides[prov] = { ...settings.llm.rewrite.overrides[prov], ...ov };
            }
        }
        rewriteAiClient = buildAiClientFor('rewrite');
        rewriter.aiClient = rewriteAiClient;
    }
    if (body.email) Object.assign(settings.email, body.email);
    if (body.email?.to !== undefined) EMAIL_CONFIG.to = settings.email.to;
    if (body.email?.bcc !== undefined) EMAIL_CONFIG.bcc = settings.email.bcc;
    if (body.paused) Object.assign(paused, body.paused);
    if (body.parallelLocalInference !== undefined) {
        settings.parallelLocalInference = body.parallelLocalInference;
        setLocalMutexEnabled(settings.parallelLocalInference);
    }

    await persistSettings();
    return settingsView();
}

// ==========================================================
// ESTADO DE LA COLA — se deriva en vivo de las carpetas, no de una base de datos aparte.
// La carpeta en la que esta un fichero YA ES su estado; duplicarlo en otro sitio es una
// fuente de verdad extra que se puede desincronizar.
// ==========================================================

const STAGE_ORDER = ['PROCESS_INPUTS', 'DOWNLOAD', 'SUMMARIZE', 'REWRITE', 'INTERPRET_SUMMARY', 'EMAIL', 'DONE'];
const STAGE_LABEL = {
    PROCESS_INPUTS: 'Encolado',
    DOWNLOAD: 'Descargando',
    SUMMARIZE: 'Resumiendo',
    REWRITE: 'Reescribiendo/Traduciendo',
    INTERPRET_SUMMARY: 'Fusionando',
    EMAIL: 'Enviando email',
    DONE: 'Terminado',
};

async function listDir(dir) {
    try { return await fs.readdir(dir); } catch { return []; }
}

/** El nombre de fichero de cada etapa lleva sufijos distintos (`.summary-part.json`,
 * `.rewrite-part.json`, `.enriched.json`, `.summary.md`, `.email.html`) — esto los reduce todos
 * al videoId desnudo para poder agrupar. `.ai.raw.json` ya no lo genera nada nuevo, pero se deja
 * el reemplazo por si queda algun fichero viejo de antes de separar esta etapa en dos. */
function videoIdFromFilename(filename) {
    return filename
        .replace(/\.summary-part\.json$/i, '')
        .replace(/\.rewrite-part\.json$/i, '')
        .replace(/\.ai\.raw\.json$/i, '')
        .replace(/\.enriched\.json$/i, '')
        .replace(/\.summary\.md$/i, '')
        .replace(/\.email\.html$/i, '')
        .replace(/\.json$/i, '');
}

/** Un `.summary-part.json` o `.rewrite-part.json` sueltos en INTERPRET_SUMMARY.INPUT (su
 * hermano todavia no llego) no estan "en Interpretar" de verdad — InterpretSummaryStage ni los
 * toca hasta que el par este completo (ver interpretJoinFilter). Mientras tanto, ese video sigue
 * "en Resumen" o "en Reescritura" segun cual de las dos etapas todavia no ha terminado, y ESA es
 * la entrada que hay que dejar que gane en record() — por eso estos se saltan aqui. */
function isOrphanInterpretPart(filename, allFilesInDir) {
    if (filename.endsWith('.summary-part.json')) {
        const videoId = filename.slice(0, -'.summary-part.json'.length);
        return !allFilesInDir.includes(`${videoId}.rewrite-part.json`);
    }
    if (filename.endsWith('.rewrite-part.json')) {
        const videoId = filename.slice(0, -'.rewrite-part.json'.length);
        return !allFilesInDir.includes(`${videoId}.summary-part.json`);
    }
    return false;
}

async function buildState() {
    const byVideo = new Map();

    const record = (videoId, stageName, bucket, filename, fullPath) => {
        if (!byVideo.has(videoId)) byVideo.set(videoId, { videoId, stage: stageName, bucket, files: [], paths: [] });
        const v = byVideo.get(videoId);
        // Se recorre en orden de avance del pipeline, asi que la ultima vez que se ve un
        // videoId es su etapa MAS AVANZADA — es justo lo que queremos mostrar.
        v.stage = stageName;
        v.bucket = bucket;
        v.files.push(filename);
        v.paths.push(fullPath);
    };

    // Un .summary-part.json/.rewrite-part.json huerfano (ver isOrphanInterpretPart) no debe
    // cambiar el stage/bucket mostrado — pero SI acaba de escribirse (la etapa hermana termino
    // hace instantes), asi que su mtime tiene que contar para `updatedAt`. Sin esto, un video que
    // termino Resumen hace un minuto seguia mostrando la hora de cuando se creo el .json original
    // en download/, horas antes — parecia parado cuando en realidad algo SI habia avanzado.
    const trackMtime = (videoId, fullPath) => {
        const v = byVideo.get(videoId);
        if (v) v.paths.push(fullPath);
    };

    for (const stageName of STAGE_ORDER) {
        if (stageName === 'DONE') continue;
        const dirs = DIRS[stageName];
        for (const bucket of ['INPUT', 'OUTPUT', 'ERROR']) {
            const dirPath = dirs[bucket];
            if (!dirPath) continue;
            const filesInDir = await listDir(dirPath);
            for (const f of filesInDir) {
                if (stageName === 'INTERPRET_SUMMARY' && bucket === 'INPUT' && isOrphanInterpretPart(f, filesInDir)) {
                    trackMtime(videoIdFromFilename(f), path.join(dirPath, f));
                    continue;
                }
                const videoId = videoIdFromFilename(f);
                // SUMMARIZE y REWRITE son hermanos en paralelo, no pasos secuenciales — un video
                // puede estar en las DOS input/ a la vez (ver fanOutOutputs). STAGE_ORDER los
                // recorre en ese orden fijo, así que sin este caso especial REWRITE siempre pisaba
                // el stage mostrado aunque SUMMARIZE fuera el que de verdad estuviera procesando
                // ese video ahora mismo (la tarjeta se veía "REWRITE, processing: false" mientras
                // el log mostraba SUMMARIZE trabajando en él).
                const summarizeIsActiveHere = stageName === 'REWRITE' && bucket === 'INPUT' &&
                    summarizer.activeVideoId === videoId;
                if (summarizeIsActiveHere) {
                    trackMtime(videoId, path.join(dirPath, f));
                    continue;
                }
                record(videoId, stageName, bucket.toLowerCase(), f, path.join(dirPath, f));
            }
        }
    }
    for (const f of await listDir(DIRS.DONE)) record(videoIdFromFilename(f), 'DONE', 'output', f, path.join(DIRS.DONE, f));

    const videos = [...byVideo.values()];
    // `updatedAt` = el mtime MAS RECIENTE entre todos los ficheros de ese video, sin importar en
    // que etapa/bucket estan — asi un video que acaba de fallar o de terminar sube al principio
    // de la lista igual, en vez de quedar enterrado en orden alfabetico entre otros 130.
    await Promise.all(videos.map(async (v) => {
        const mtimes = await Promise.all(v.paths.map(p => fs.stat(p).then(s => s.mtimeMs).catch(() => 0)));
        v.updatedAt = Math.max(0, ...mtimes);
        delete v.paths;
    }));

    return videos;
}

const ACTIVE_BY_STAGE = {
    DOWNLOAD: downloader,
    SUMMARIZE: summarizer,
    REWRITE: rewriter,
    INTERPRET_SUMMARY: interpretSummaryStage,
    EMAIL: emailer,
};

/** El worker de cada etapa procesa UN fichero a la vez (ver runStageWorker en
 * resumir_video.js), pero /api/state antes marcaba como "procesando" a TODOS los que estuvieran
 * en input/ de esa etapa — con 4 videos esperando turno, la UI los pintaba a los 4 con el
 * spinner activo, cuando en realidad solo uno estaba corriendo de verdad y los otros 3 ni habian
 * empezado. `stage.activeVideoId` es la fuente de verdad de cual es cual. */
function activeInfoFor(v) {
    const stage = ACTIVE_BY_STAGE[v.stage];
    if (!stage || v.bucket !== 'input' || stage.activeVideoId !== v.videoId) {
        return { processing: false, aiProgress: null };
    }
    if ((v.stage === 'SUMMARIZE' || v.stage === 'REWRITE') && stage.currentJob) {
        const j = stage.currentJob;
        return {
            processing: true,
            aiProgress: {
                step: j.step,
                currentChunk: j.currentChunk,
                totalChunks: j.totalChunks,
                fileSizeBytes: j.fileSizeBytes,
                elapsedSec: Math.round((Date.now() - j.startedAt) / 1000),
                // El modelo configurado AHORA para esta etapa — no j.model (eso solo se rellena
                // en Rewrite tras el PRIMER chunk, asi que durante todo el chunk 1 la UI se
                // quedaria sin dato). stage.aiClient.modelName ya se conoce desde antes de lanzar
                // la peticion.
                model: stage.aiClient.modelName,
            },
        };
    }
    return { processing: true, aiProgress: null };
}

/** Rellena titulo/idioma/modelo/url en cuanto existan — aparecen en cuanto termina 2A o 2B,
 * asi que antes de eso el video solo se ve por su id. */
async function enrichVideo(v) {
    const candidates = [
        path.join(DIRS.DONE, `${v.videoId}.enriched.json`),
        path.join(DIRS.EMAIL.OUTPUT, `${v.videoId}.enriched.json`),
        path.join(DIRS.EMAIL.INPUT, `${v.videoId}.enriched.json`),
        path.join(DIRS.INTERPRET_SUMMARY.OUTPUT, `${v.videoId}.enriched.json`),
        // Mientras espera a su hermano, lo unico que puede haber aqui es UNA de las dos mitades
        // (ver isOrphanInterpretPart) — cualquiera de las dos vale para title/language/url.
        path.join(DIRS.INTERPRET_SUMMARY.INPUT, `${v.videoId}.summary-part.json`),
        path.join(DIRS.INTERPRET_SUMMARY.INPUT, `${v.videoId}.rewrite-part.json`),
        path.join(DIRS.SUMMARIZE.OUTPUT, `${v.videoId}.summary-part.json`),
        path.join(DIRS.REWRITE.OUTPUT, `${v.videoId}.rewrite-part.json`),
        // Estos ultimos no tienen title/language (aun no ha pasado por el modelo), pero SI tienen
        // `url` desde el principio — es el job normalizado que genero ProcessInputsStage. Sin esto,
        // un video que falla en la descarga (antes de que exista ningun resumen/reescritura) se
        // queda sin URL en la UI, que es justo el caso en el que mas hace falta poder pinchar en
        // el enlace.
        path.join(DIRS.SUMMARIZE.INPUT, `${v.videoId}.json`),
        path.join(DIRS.SUMMARIZE.ERROR, `${v.videoId}.json`),
        path.join(DIRS.REWRITE.INPUT, `${v.videoId}.json`),
        path.join(DIRS.REWRITE.ERROR, `${v.videoId}.json`),
        path.join(DIRS.DOWNLOAD.INPUT, `${v.videoId}.json`),
        path.join(DIRS.DOWNLOAD.ERROR, `${v.videoId}.json`),
    ];
    for (const p of candidates) {
        try {
            const data = JSON.parse(await fs.readFile(p, 'utf8'));
            // El .summary-part.json (SUMMARIZE ya termino, Rewrite/Fusion todavia no) no tiene
            // title/language como campo propio: el modelo los devuelve embebidos en las primeras
            // lineas de rawContent ("TITLE: ...\nLANGUAGE: ...") y solo InterpretSummaryStage los
            // extrae al fusionar. Sin este parseo, data.title siempre era undefined aqui y la
            // tarjeta se quedaba en "esperando titulo" durante todo Rewrite aunque el drawer de
            // detalle (que si parsea rawContent, ver /api/videos/:id/data) ya lo mostrara bien.
            let parsedFromRaw = null;
            if (data.rawContent) {
                try { parsedFromRaw = parseSummaryOutput(data.rawContent); } catch { /* rawContent aun incompleto/no parseable */ }
            }
            return {
                ...v,
                stageLabel: STAGE_LABEL[v.stage] || v.stage,
                title: parsedFromRaw?.title || data.title || null,
                language: parsedFromRaw?.language || data.language || null,
                // data.model existe una vez que InterpretSummary junto las dos mitades;
                // summaryModel/rewriteModel es lo que hay ANTES de eso, mientras cada etapa
                // todavia esta trabajando por su lado. Se exponen los tres: la UI necesita saber
                // CUAL modelo hizo CUAL trabajo, no solo un "modelo A + modelo B" sin etiquetar.
                model: data.model || data.summaryModel || data.rewriteModel || null,
                summaryModel: data.summaryModel || null,
                rewriteModel: data.rewriteModel || null,
                url: data.url || null,
            };
        } catch { /* ese candidato no existe o no es JSON — se prueba el siguiente */ }
    }
    return {
        ...v,
        stageLabel: STAGE_LABEL[v.stage] || v.stage,
        title: null,
        language: null,
        model: null,
        summaryModel: null,
        rewriteModel: null,
        url: null,
    };
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

/** "Usar sin pulir": para cuando Resumen ya termino pero Rewrite va lento o se ha atascado, y el
 * usuario prefiere que el video llegue a DONE/email YA, con el transcript crudo como cuerpo
 * completo en vez de esperar la reescritura/traduccion fiel. Saca a Rewrite de en medio y
 * sintetiza el rewrite-part que le falta a Fusion — el resto del pipeline (Fusion, email) no
 * necesita saber que esto paso, ve un rewrite-part normal, solo que con rewriteModel = null y
 * el transcript entero como unico chunk. */
async function skipRewrite(videoId) {
    const rewriteInputPath = path.join(DIRS.REWRITE.INPUT, `${videoId}.json`);
    const rewriteErrorPath = path.join(DIRS.REWRITE.ERROR, `${videoId}.json`);

    let rawContent = null;
    for (const p of [rewriteInputPath, rewriteErrorPath]) {
        rawContent = await fs.readFile(p, 'utf8').catch(() => null);
        if (rawContent !== null) break;
    }
    if (rawContent === null) {
        throw Object.assign(
            new Error(`${videoId} no esta pendiente de reescritura (ni en cola ni en error de Rewrite)`),
            { status: 409 }
        );
    }
    const data = JSON.parse(rawContent);

    // Si el worker esta trabajando en ESTE video ahora mismo, abortar la peticion en vuelo — su
    // propio catch intentara mover el input a error, pero eso es un fs.rename con .catch(()=>{})
    // silencioso (ver moveToError), asi que no pasa nada si para entonces ya lo hemos borrado
    // nosotros mismos mas abajo.
    if (rewriter.currentJob?.videoId === videoId) {
        rewriter.currentJob.abortController.abort();
    }

    await fs.unlink(rewriteInputPath).catch(() => {});
    await fs.unlink(rewriteErrorPath).catch(() => {});

    const rewritePart = {
        videoId,
        rewriteModel: null,
        rewriteClient: null,
        rewriteSkipped: true,
        rewriteDate: new Date().toISOString(),
        fullContentChunks: [data.transcript || ''],
    };
    await fs.writeFile(
        path.join(DIRS.INTERPRET_SUMMARY.INPUT, `${videoId}.rewrite-part.json`),
        JSON.stringify(rewritePart, null, 2)
    );

    // El relay de Summarize a Interpret corre solo cada ~250ms (ver runStageWorker) — normalmente
    // el hermano ya esta ahi para cuando se llega aqui, pero si no, se copia a mano en vez de
    // fiarse de esa carrera.
    const summaryDest = path.join(DIRS.INTERPRET_SUMMARY.INPUT, `${videoId}.summary-part.json`);
    const alreadyThere = await fs.access(summaryDest).then(() => true).catch(() => false);
    if (!alreadyThere) {
        const summarySrc = await fs.readFile(path.join(DIRS.SUMMARIZE.OUTPUT, `${videoId}.summary-part.json`), 'utf8').catch(() => null);
        if (summarySrc !== null) await fs.writeFile(summaryDest, summarySrc);
        // Si tampoco esta ahi, Resumen no ha terminado de verdad todavia — no deberia pasar, la
        // UI solo ofrece este boton cuando summaryModel ya existe en /api/state.
    }

    await logger.log({
        stage: 'Rewrite',
        status: 'SUCCESS',
        inputs: [`${videoId}.json`],
        outputs: [`${videoId}.rewrite-part.json`],
        note: 'sin pulir — transcript crudo, Rewrite omitido a peticion del usuario',
        ts: new Date().toISOString(),
    });
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
            const stageKey = parsed.stage === 'rewrite' ? 'rewrite' : 'summarize';
            if (!provider) return sendJson(res, 400, { error: 'falta "provider"' });
            try {
                // Si el usuario todavia no escribio una key/URL nueva en el formulario, se
                // prueba con la ya guardada en Settings PARA ESA ETAPA — summarize y rewrite
                // pueden tener keys distintas para el mismo proveedor, asi que "stage" decide
                // cual de las dos usar como respaldo. Asi el combo funciona tanto para "quiero
                // ver los modelos de lo que ya tengo configurado" como para "acabo de pegar una
                // key nueva, a ver que modelos trae".
                const saved = settings.llm[stageKey].overrides[provider] || {};
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
                return {
                    ...e,
                    ...activeInfoFor(v),
                    readAt: readStatus[v.videoId] || null,
                    // El modelo configurado AHORA para cada etapa — no lo que summaryModel/
                    // rewriteModel diga que se uso. Sin esto, un video cuya mitad ya termino con
                    // un modelo que luego se cambio en Settings se ve indistinguible de uno que
                    // va a correr (o reintentar) con el modelo actual — la UI no puede avisar de
                    // que ese dato es historico si no sabe cual es el "actual" para comparar.
                    currentSummarizeModel: summarizeAiClient.modelName,
                    currentRewriteModel: rewriteAiClient.modelName,
                };
            }));
            // El que esta procesando de VERDAD ahora mismo, primero siempre — su fichero de
            // entrada no se toca (mtime) hasta que termina, asi que por updatedAt solo podia
            // aparecer en cualquier punto de la lista segun cuando se encolo, no segun que esta
            // activo ahora. Entre los que no estan procesando, sigue ganando el mas reciente.
            enriched.sort((a, b) => (b.processing - a.processing) || (b.updatedAt - a.updatedAt));
            return sendJson(res, 200, enriched);
        }

        // ==========================================================
        // AGENT — agent.mjs (corriendo en una IP residencial real) consulta/entrega aqui. Nunca
        // publico: sin AGENT_TOKEN configurado, ambos 404 en vez de 401 -- no hay pista de que
        // esta ruta existe si el modo agente no esta en uso.
        // ==========================================================
        if (url.pathname === '/api/agent/jobs' || url.pathname.startsWith('/api/agent/jobs/')) {
            if (!AGENT_TOKEN) return sendJson(res, 404, { error: 'not found' });
            const auth = req.headers['authorization'] || '';
            if (auth !== `Bearer ${AGENT_TOKEN}`) return sendJson(res, 401, { error: 'unauthorized' });

            if (req.method === 'GET' && url.pathname === '/api/agent/jobs') {
                const files = await fs.readdir(DIRS.AGENT_JOBS.PENDING).catch(() => []);
                const jobs = await Promise.all(
                    files.filter((f) => f.endsWith('.json')).map(async (f) => {
                        try {
                            return JSON.parse(await fs.readFile(path.join(DIRS.AGENT_JOBS.PENDING, f), 'utf-8'));
                        } catch {
                            return null;
                        }
                    })
                );
                return sendJson(res, 200, jobs.filter(Boolean));
            }

            if (req.method === 'POST' && url.pathname.startsWith('/api/agent/jobs/') && url.pathname.endsWith('/result')) {
                const videoId = url.pathname.split('/')[4];
                let body = '';
                for await (const chunk of req) body += chunk;
                let parsed;
                try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
                await fs.writeFile(path.join(DIRS.AGENT_JOBS.DONE, `${videoId}.json`), JSON.stringify(parsed, null, 2));
                return sendJson(res, 200, { ok: true });
            }
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/videos/') && url.pathname.endsWith('/cancel')) {
            const videoId = url.pathname.split('/')[3];
            // Solo Summarize y Rewrite pueden cancelarse de verdad ahora mismo: son las unicas
            // etapas cuyo cliente de IA soporta abortar una peticion en vuelo (ver
            // generateContent en resumir_video.js) — las demas etapas son lo bastante rapidas
            // (descarga, escribir ficheros, mandar un email ya generado) como para que
            // cancelarlas a mitad no sea algo que de verdad haga falta.
            const activeStage = [summarizer, rewriter].find(s => s.currentJob?.videoId === videoId);
            if (!activeStage) {
                return sendJson(res, 409, { error: `${videoId} no se esta resumiendo ni reescribiendo ahora mismo` });
            }
            activeStage.currentJob.abortController.abort();
            return sendJson(res, 200, { cancelling: videoId });
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/videos/') && url.pathname.endsWith('/skip-rewrite')) {
            const videoId = url.pathname.split('/')[3];
            try {
                await skipRewrite(videoId);
                return sendJson(res, 200, { skipped: videoId });
            } catch (err) {
                return sendJson(res, err.status || 500, { error: err.message });
            }
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
                if (enrichedRaw !== null) {
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
                        fullContentIsPreview: false,
                        markdown: enriched.markdown || '',
                        emailHtml, // null si aun no se ha enviado
                        emailIsPreview: false,
                        readAt: readStatus[videoId] || null,
                    });
                }

                // Fusion (o Rewrite) todavia no ha terminado, pero Resumen puede llevar rato
                // esperando a su hermana — no hay razon para bloquear la lectura hasta que las
                // dos etapas EN PARALELO terminen si una de las dos ya esta lista. El
                // ".summary-part.json" solo (sin su pareja ".rewrite-part.json" todavia) vive en
                // INTERPRET_SUMMARY.INPUT mientras espera, o en SUMMARIZE.OUTPUT en el instante
                // justo antes de que el worker lo mueva ahi — se comprueban los dos sitios.
                const summaryPartRaw = await readFirstExisting([
                    path.join(DIRS.INTERPRET_SUMMARY.INPUT, `${videoId}.summary-part.json`),
                    path.join(DIRS.SUMMARIZE.OUTPUT, `${videoId}.summary-part.json`),
                ]);
                if (summaryPartRaw === null) { res.writeHead(404).end('resumen no encontrado todavia'); return; }
                const summaryPart = JSON.parse(summaryPartRaw);
                let parsed;
                try {
                    parsed = parseSummaryOutput(summaryPart.rawContent);
                } catch (err) {
                    res.writeHead(404).end(`resumen todavia no es legible: ${err.message}`);
                    return;
                }
                const previewTranscript = summaryPart.transcript || '';
                // Mismo template que el email real (buildEmailHtml, compartida con EmailStage) —
                // con lo que YA hay (titulo/resumen/transcript crudo) el resultado es casi
                // idéntico al que se mandaria de verdad, no una maqueta vacia. Nunca se envia ni
                // se escribe a disco desde aqui, solo se devuelve para que el drawer lo muestre.
                const previewEmailHtml = buildEmailHtml({
                    videoId,
                    title: parsed.title || 'YouTube Summary',
                    model: summaryPart.summaryModel,
                    client: summaryPart.summaryClient,
                    summaryBody: parsed.content || '',
                    fullContent: previewTranscript,
                });
                return sendJson(res, 200, {
                    videoId,
                    url: summaryPart.url || `https://www.youtube.com/watch?v=${videoId}`,
                    title: parsed.title || null,
                    language: parsed.language || null,
                    model: summaryPart.summaryModel || null,
                    summaryBody: parsed.content || '',
                    // El transcript crudo (sin reescribir/traducir) SI existe ya en el
                    // summary-part — se sirve como vista previa honesta en vez de dejar la
                    // pestaña de transcripcion vacia hasta que Rewrite termine.
                    fullContent: previewTranscript,
                    fullContentIsPreview: true,
                    markdown: '',
                    emailHtml: previewEmailHtml,
                    emailIsPreview: true,
                    readAt: readStatus[videoId] || null,
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

        if (req.method === 'POST' && url.pathname.startsWith('/api/videos/') && url.pathname.endsWith('/read')) {
            const videoId = url.pathname.split('/')[3];
            readStatus[videoId] = new Date().toISOString();
            await persistReadStatus();
            return sendJson(res, 200, { videoId, readAt: readStatus[videoId] });
        }

        if (req.method === 'DELETE' && url.pathname.startsWith('/api/videos/') && url.pathname.endsWith('/read')) {
            const videoId = url.pathname.split('/')[3];
            delete readStatus[videoId];
            await persistReadStatus();
            return sendJson(res, 200, { videoId, readAt: null });
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
