// Agente local: corre en una maquina con IP residencial real (tu Mac), consulta al servidor por
// trabajos de descarga pendientes, y hace el trabajo aqui -- reusando fetchTranscriptWithFallback
// de resumir_video.js tal cual, sin duplicar logica. Ver AGENT_MODE en resumir_video.js para el
// porque: ni PO Token ni cookies bastaron contra el bloqueo de YouTube a la IP del servidor
// (2026-09-21), asi que la descarga se delega entera a una IP que YouTube SI trata como legitima.
//
// Uso: node agent.mjs (necesita AGENT_SERVER_URL y AGENT_TOKEN en .env)
import 'dotenv/config';
import { DownloadStage, EventLogger } from './resumir_video.js';

const SERVER_URL = process.env.AGENT_SERVER_URL;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const POLL_MS = Number(process.env.AGENT_POLL_MS || 15000);

if (!SERVER_URL || !AGENT_TOKEN) {
    console.error('❌ Faltan AGENT_SERVER_URL y/o AGENT_TOKEN en .env -- el agente no puede arrancar sin ellos.');
    process.exit(1);
}

// EventLogger solo escribe en pipeline-data/events/events.log local -- inofensivo, no lo usa
// fetchTranscriptWithFallback para nada mas que ese log de cortesia.
const downloader = new DownloadStage(new EventLogger());

async function fetchPendingJobs() {
    const res = await fetch(`${SERVER_URL}/api/agent/jobs`, {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    if (!res.ok) throw new Error(`GET /api/agent/jobs -> HTTP ${res.status}`);
    return res.json();
}

async function postResult(videoId, result) {
    const res = await fetch(`${SERVER_URL}/api/agent/jobs/${videoId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_TOKEN}` },
        body: JSON.stringify(result),
    });
    if (!res.ok) throw new Error(`POST result -> HTTP ${res.status}`);
}

async function processJob(job) {
    console.log(`🎬 Procesando ${job.videoId} (${job.url})...`);
    try {
        const { text, languageUsed } = await downloader.fetchTranscriptWithFallback(job.url);
        await postResult(job.videoId, { text, languageUsed });
        console.log(`✅ ${job.videoId} enviado al servidor (${languageUsed}, ${text.length} chars).`);
    } catch (err) {
        console.error(`❌ ${job.videoId}: ${err.message}`);
        // Avisar al servidor del fallo tambien -- si esto falla, el timeout del lado del servidor
        // (15 min) lo hara caer a error/ igual, solo que mas tarde y sin el mensaje real.
        await postResult(job.videoId, { error: err.message }).catch((e) =>
            console.error(`   (y ademas no pude avisar al servidor del error: ${e.message})`)
        );
    }
}

console.log(`🏠 Agente local arrancado -- servidor: ${SERVER_URL}, consultando cada ${POLL_MS / 1000}s`);

while (true) {
    try {
        const jobs = await fetchPendingJobs();
        for (const job of jobs) {
            await processJob(job);
        }
    } catch (err) {
        console.error(`⚠️  No se pudo consultar al servidor: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
}
