# youtube-sumarizer

Descarga la transcripción de un vídeo de YouTube, la resume y la reescribe con un LLM, y envía el resultado por email.

## Uso

Dos formas de correrlo: de un tiro con la CLI, o como servidor persistente.

```bash
node resumir_video.js --all --url "https://www.youtube.com/watch?v=IOZv3iVZIhg"
```

### Servidor persistente

```bash
node server.js
```

Arranca las 4 etapas (`download`, `ai-summarize`, `interpret-summary`, `email`) como workers que
corren a la vez para siempre, vigilando sus propias carpetas — a diferencia de la CLI, que
procesa lo que haya en la cola y sale. Por defecto escucha en `http://localhost:4173`
(`PORT` en `.env` lo cambia).

Con el servidor corriendo:

- **UI**: abre `http://localhost:4173` — tabla con la cola en vivo (se refresca sola) y un
  formulario para encolar URLs.
- **API**:
  - `GET /api/state` — la cola completa, con la etapa de cada vídeo derivada en vivo de las
    carpetas (sin base de datos aparte).
  - `GET /api/videos/:id/reader` — el resumen ya renderizado a HTML.
  - `GET /api/videos/:id/email` — el email tal cual se envió.
  - `GET /api/videos/:id/markdown` — el `.summary.md` en crudo.
  - `POST /api/enqueue` con `{ "url": "..." }` o `{ "urls": [...] }`.

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
falta reiniciar ni avisar a nada. Si el servidor no está en `http://localhost:4173`, apunta con
`SUMARIZER_SERVER_URL`:

```bash
SUMARIZER_SERVER_URL=http://mi-servidor:4173 node queue-cli.js "https://youtu.be/abc"
```

### Requisitos externos

- **`yt-dlp`** en el `PATH` — la fase de descarga lo invoca como binario, no es una dependencia npm.

## Providers

Se elige con `AI_PROVIDER` en `.env`. El cliente se construye una vez por run (`createAiClient`) y lo usa la fase *AI Summarize*.

| `AI_PROVIDER` | Key en `.env` | Modelo | Notas |
|---|---|---|---|
| `lmstudio` *(default)* | `LMSTUDIO_API_KEY` | hardcodeado en `LMSTUDIO_MODEL_NAME` | Local, `http://localhost:1234/v1`. Sin coste y sin rate limit |
| `nvidia` | `NVIDIA_API_KEY` | `NVIDIA_MODEL` | NVIDIA Cloud, OpenAI-compatible |
| `gemini` | `GEMINI_API_KEY` | hardcodeado en `GEMINI_MODEL` | SDK propio (`@google/genai`) |
| `deepseek` | `DEEPSEEK_API_KEY` | hardcodeado en `DEEPSEEK_MODEL` | API directa de DeepSeek |

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
