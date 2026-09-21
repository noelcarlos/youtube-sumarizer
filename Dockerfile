FROM node:22-alpine AS builder
WORKDIR /app

# package.json de la raíz declara "workspaces": ["web"] -- un solo npm ci en la raíz instala las
# deps de los dos (server.js y web/), hoisted a un único node_modules.
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json

RUN npm ci

COPY . .

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# resumir_video.js invoca el binario `yt-dlp` (execAsync/spawn) para descargar subtitulos -- no es
# una dependencia npm, hay que instalarlo a nivel de sistema. En Alpine/musl el binario standalone
# oficial de yt-dlp (compilado para glibc) no funciona bien, así que via pip (puro Python).
#
# deno: yt-dlp lo usa como runtime de JS para resolver el challenge anti-bot de YouTube ("Sign in
# to confirm you're not a bot", visto en logs reales desde la IP de este servidor) -- sin un
# runtime de JS soportado, yt-dlp avisa que la extraccion esta degradada/deprecada.
RUN apk add --no-cache python3 py3-pip deno && \
    pip install --no-cache-dir --break-system-packages yt-dlp bgutil-ytdlp-pot-provider

# El plugin de arriba necesita el PO Token provider en modo "script" (sin servidor HTTP aparte,
# recomendado solo para bajo volumen, que es este caso): clona el repo y compila el server/ una
# vez en build time. resumir_video.js pasa --extractor-args
# "youtubepot-bgutilscript:server_home=/opt/bgutil-ytdlp-pot-provider/server" a cada llamada.
#
# Sus dependencias incluyen "canvas" (compila nativo, resuelve retos visuales de BotGuard) --
# necesita cairo/pango/jpeg/giflib + toolchain en Alpine, si no falla node-gyp con
# "pkg-config: not found". Runtime libs (sin -dev) se quedan para que el binario compilado siga
# funcionando; el resto de build-only se borra despues.
RUN apk add --no-cache git cairo pango jpeg giflib && \
    apk add --no-cache --virtual .build-deps build-base python3-dev pkgconfig cairo-dev pango-dev jpeg-dev giflib-dev && \
    git clone --single-branch --branch 2.0.0 --depth 1 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider && \
    cd /opt/bgutil-ytdlp-pot-provider/server && \
    npm ci --include=dev && ./node_modules/.bin/tsc && \
    apk del .build-deps git

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/resumir_video.js ./resumir_video.js
COPY --from=builder /app/queue-cli.js ./queue-cli.js

COPY --from=builder /app/web/.next ./web/.next
COPY --from=builder /app/web/package.json ./web/package.json
COPY --from=builder /app/web/next.config.js ./web/next.config.js

# pipeline-data es estado real (cola de videos en curso) -- se monta como bind mount desde el
# host (ver titan-badger-global-services/docker-compose.yml), este mkdir solo evita que falte el
# punto de montaje si el volumen aún no existe en el primer arranque.
RUN mkdir -p /app/pipeline-data

COPY docker-start.sh ./docker-start.sh
RUN chmod +x docker-start.sh

EXPOSE 3000
CMD ["./docker-start.sh"]
