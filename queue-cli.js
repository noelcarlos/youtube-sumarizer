#!/usr/bin/env node
// CLI minimo: solo empuja URLs al servidor (server.js) via /api/enqueue. No procesa nada el
// mismo — eso lo hacen los 4 workers que ya estan corriendo en el servidor.
const urls = process.argv.slice(2).flatMap(a => a.split(',')).map(u => u.trim()).filter(Boolean);

if (urls.length === 0) {
    console.error('Uso: node queue-cli.js <url1> [url2 ...]');
    console.error('     (o separadas por coma: node queue-cli.js "url1,url2")');
    process.exit(1);
}

const base = process.env.SUMARIZER_SERVER_URL || 'http://localhost:4577';

const res = await fetch(`${base}/api/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
});

if (!res.ok) {
    console.error(`❌ Error ${res.status}: ${await res.text()}`);
    process.exit(1);
}

const body = await res.json();
console.log(`✅ Encolados ${body.enqueued} video(s). Sigue el progreso en ${base}`);
