# youtube-sumarizer

Descarga la transcripción de un vídeo de YouTube, la resume y la reescribe con un LLM, y envía el resultado por email.

## Uso

Dos formas de correrlo: de un tiro con la CLI, o como servidor persistente.

```bash
node resumir_video.js --all --url "https://www.youtube.com/watch?v=IOZv3iVZIhg"
```

### Servidor persistente

Monorepo con workspaces npm: `server.js` en la raíz es el backend (API + los 4 workers del
pipeline), y `web/` es la UI, una app Next.js 16 (App Router) — dos procesos separados, cada uno
en su puerto. Primera vez, un solo `npm install` en la raíz instala las dos partes.

**Backend** (API + workers, `http://127.0.0.1:4577`):

```bash
npm start
```

`127.0.0.1` explícito, no el wildcard, para no repetir con nadie el mismo choque de puerto que
tuvo `iron-agile-bot` con este proyecto (su propio `web/next.config.js` lo cuenta, ver más abajo).
4577 es distinto del `4173` de `iron-agile-bot` a propósito. Arranca las 4 etapas (`download`,
`ai-summarize`, `interpret-summary`, `email`) como workers que corren a la vez para siempre,
vigilando sus propias carpetas — a diferencia de la CLI, que procesa lo que haya en la cola y
sale.

**UI** (Next.js, `http://localhost:3000`):

```bash
npm run dev            # desarrollo, con hot-reload
# o en producción:
npm run build && npm run start:web
```

`web/next.config.js` reenvía `/api/*` al backend (127.0.0.1:4577) vía `rewrites()` — el mismo
patrón que usaba el proxy de dev de Vite, pero que aquí también funciona en producción. Hacen
falta los DOS procesos corriendo a la vez (backend + UI) — abre siempre `http://localhost:3000`,
no el 4577 (eso es sólo la API).

- **UI**: pestañas por etapa (Descarga / Resumen IA / Interpretar / Email / Terminado / Error),
  formulario para encolar con botón de encolar del portapapeles (un click), tarjetas en grid que
  aprovecha el ancho completo, y un drawer de lectura ("leer resumen") con 3 modos (mitad /
  pantalla completa / split con el reproductor de YouTube embebido) y 4 pestañas (Resumen / Email
  / .md / Transcripción).
- **API**:
  - `GET /api/state` — la cola completa, con la etapa de cada vídeo derivada en vivo de las
    carpetas (sin base de datos aparte).
  - `GET /api/videos/:id/data` — el `enriched.json` entero como JSON (resumen, transcripción,
    modelo, email) en una sola llamada, para el drawer.
  - `GET /api/videos/:id/reader` — el resumen ya renderizado a HTML (fuera del drawer).
  - `GET /api/videos/:id/email` — el email tal cual se envió.
  - `GET /api/videos/:id/markdown` — el `.summary.md` en crudo.
  - `POST /api/enqueue` con `{ "url": "..." }` o `{ "urls": [...] }`.
  - `POST /api/videos/:id/requeue` — mueve un vídeo de `error/` de vuelta a `input/` de su etapa.
  - `POST /api/videos/:id/resend` — reenvía el `.email.html` ya generado, sin pasar por el pipeline.
  - `DELETE /api/videos/:id` — borra definitivamente un vídeo que está en `error/`.

### CLI para encolar (`queue-cli.js`)

No procesa nada él mismo — solo hace el `POST /api/enqueue` contra el servidor que ya tiene que
estar corriendo (`node server.js`, en otra terminal o en background).

```bash
# una URL
node queue-cli.js "https://www.youtube.com/watch?v=IOZv3iVZIhg"

# varias de golpe, separadas por coma
node queue-cli.js "https://youtu.be/abc,https://youtu.be/xyz"

# o varios argumentos sueltos
node queue-cli.js "https://youtu.be/abc" "https://youtu.be/xyz"
```

El worker de descarga que ya está corriendo la recoge sola en su siguiente sondeo — no hace
falta reiniciar ni avisar a nada. Si el servidor no está en `http://localhost:4577`, apunta con
`SUMARIZER_SERVER_URL`:

```bash
SUMARIZER_SERVER_URL=http://mi-servidor:9000 node queue-cli.js "https://youtu.be/abc"
```

### Agente de descarga local (`agent.mjs`)

YouTube bloquea la IP de datacenter del servidor de producción ("Sign in to confirm you're not a
bot" / `playability status: LOGIN_REQUIRED`) — ni un PO Token (`bgutil-ytdlp-pot-provider`) ni
cookies de sesión reales bastaron, confirmado en producción el 2026-09-21: Google trata la sesión
como no confiable en cuanto detecta el salto de una IP residencial a una de datacenter.

La solución: `AGENT_MODE=true` en el servidor hace que `DownloadStage` deje el trabajo pendiente en
`pipeline-data/agent-jobs/pending/` en vez de invocar `yt-dlp` él mismo, y espera (con timeout de 15
min, cae a `error/` de forma visible si nadie lo recoge) a que aparezca el resultado en
`agent-jobs/done/`. `agent.mjs`, corriendo en una máquina con IP residencial real, hace ese trabajo
— reutiliza `DownloadStage.fetchTranscriptWithFallback()` tal cual, sin duplicar nada de la lógica
de yt-dlp.

**Para correrlo** (en tu propia máquina, no en el servidor):

```bash
npm run agent
```

Necesita en `.env`:

```
AGENT_SERVER_URL=https://youtube-sumarizer.mparue.com
AGENT_TOKEN=<mismo valor que el secret AGENT_TOKEN del servidor — nunca lo cambies en un solo sitio>
```

Consulta `GET /api/agent/jobs` cada `AGENT_POLL_MS` (default 15s) y devuelve el resultado a
`POST /api/agent/jobs/:videoId/result`, autenticado con `Authorization: Bearer $AGENT_TOKEN` — esa
ruta está excluida a propósito del login de Google (`web/src/middleware.js`), no tiene ni necesita
sesión.

**El tradeoff real:** mientras tu máquina esté dormida o desconectada, los vídeos encolados se
quedan esperando — no es "se procesa al encolar", es "se procesa cuando el agente esté despierto".
Sin `AGENT_MODE` (o corriendo en local, donde la IP no está bloqueada), `DownloadStage` sigue
funcionando exactamente igual que siempre, sin ningún agente de por medio.

### Requisitos externos

- **`yt-dlp`** en el `PATH` — la fase de descarga lo invoca como binario, no es una dependencia npm.
- **`deno`** — runtime de JS que yt-dlp usa para resolver el challenge anti-bot de YouTube.
- **`bgutil-ytdlp-pot-provider`** (modo script, clonado/compilado en el `Dockerfile`) — genera el
  PO Token; por sí solo no basta contra el bloqueo de IP de datacenter (ver arriba), pero sigue
  haciendo falta para todo lo demás.

## Providers

Se elige con `AI_PROVIDER` en `.env`. El cliente se construye una vez por run (`createAiClient`) y lo usa la fase *AI Summarize*.

| `AI_PROVIDER` | Key en `.env` | Modelo | Notas |
|---|---|---|---|
| `lmstudio` *(default)* | `LMSTUDIO_API_KEY` | hardcodeado en `LMSTUDIO_MODEL_NAME` | Local, `http://localhost:1234/v1`. Sin coste y sin rate limit |
| `nvidia` | `NVIDIA_API_KEY` | `NVIDIA_MODEL` | NVIDIA Cloud, OpenAI-compatible |
| `gemini` | `GEMINI_API_KEY` | hardcodeado en `GEMINI_MODEL` | SDK propio (`@google/genai`) |
| `deepseek` | `DEEPSEEK_API_KEY` | hardcodeado en `DEEPSEEK_MODEL` | API directa de DeepSeek |
| `xkiro` | `XKIRO_API_KEY` | `XKIRO_MODEL` | OpenAI-compatible, catálogo de modelos `:free` (Qwen/MiniMax/Mistral/SenseNova) |
| `zai` | `ZAI_API_KEY` | `ZAI_MODEL` | OpenAI-compatible, GLM — solo `glm-4.5-flash`/`glm-4.7-flash` son gratis, el resto de GLM pide saldo |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | OpenAI-compatible, enruta a terceros — los modelos `:free` comparten un pool con rate-limit propio, no es la cuenta |

Si falta la key de un provider cloud, el run falla al arrancar con el nombre de la variable que hay que poner, en vez de salir un 401 opaco a mitad de proceso.

### Modelos de NVIDIA Cloud (`AI_PROVIDER=nvidia`)

Configura el activo con `NVIDIA_MODEL`. Los adecuados para resumir y reescribir prosa, de más rápido a mejor:

| Modelo | Notas |
|---|---|
| `nvidia/nemotron-3.5-lightning-30b-a3b` | **Default.** 30B totales pero ~3B activos (A3B) → decodifica rápido |
| `mistralai/mistral-nemotron` | Sin razonamiento: cero overhead de "pensar", que aquí no aporta. Buen español |
| `nvidia/nemotron-3-super-120b-a12b` | A12B activos, punto medio |
| `deepseek-ai/deepseek-v4-pro-0813` | Alternativa fuerte no-Nemotron |
| `nvidia/nemotron-3-ultra-550b-a55b` | Mejor calidad, notablemente más lento (A55B activos) |

La key da acceso a 81 modelos; `curl https://integrate.api.nvidia.com/v1/models -H "Authorization: Bearer $NVIDIA_API_KEY"` lista todos. Los ventanas de contexto por modelo están en build.nvidia.com, no en ese endpoint.

Evita los `*-coder-*`, `codestral` y `codellama` (afinados a código, peores en prosa y en español), los `*-embed-*` / `*-safety-*` / `*-guard-*` (no son generativos) y los `*-vl-*` / `*-vision-*` (no aportan nada con texto ya extraído).

## Pipeline

Cinco fases. Cada una tiene sus carpetas `input/output/error` bajo `pipeline-data/`, y cada fichero se mueve del `output/` de una fase al `input/` de la siguiente en cuanto termina. La cola *es* el sistema de ficheros, y `error/` es la dead-letter queue: para reintentar, copia el fichero de `error/` al `input/` de su fase.

Con la CLI (`resumir_video.js`) las fases corren en orden, una detrás de otra, dentro del mismo proceso que arranca y termina. Con el servidor (`server.js`) las 4 últimas corren a la vez, cada una vigilando su propia carpeta para siempre — así el vídeo 2 puede estar descargándose mientras el vídeo 1 ya está siendo resumido.

| # | Fase | Produce |
|---|---|---|
| 0 | process-inputs | job normalizado `{videoId}.json` |
| 1 | download | transcripción |
| 2A | ai-summarize | texto crudo del modelo `{videoId}.ai.raw.json` |
| 2B | interpret-summary | `{videoId}.enriched.json` + `{videoId}.summary.md` |
| 3 | email | envío por Gmail + `{videoId}.email.html` |

`pipeline-data/events/events.log` es un registro append-only de auditoría: no lo lee nadie, el estado del pipeline sale del contenido de las carpetas.
