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

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/resumir_video.js ./resumir_video.js
COPY --from=builder /app/queue-cli.js ./queue-cli.js

COPY --from=builder /app/web/.next ./web/.next
COPY --from=builder /app/web/public ./web/public
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
