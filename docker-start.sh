#!/bin/sh
set -e

# server.js y web/ (Next.js) van en el mismo contenedor a propósito: web/next.config.js reenvía
# /api/state, /api/enqueue, /api/settings a http://127.0.0.1:4577 (hardcodeado, mismo patrón que
# el proxy de Vite en dev) -- en contenedores separados ese 127.0.0.1 no resolvería al otro.
node server.js &
cd web
# npm workspaces hoistea "next" al node_modules de la raíz -- no hay web/node_modules propio, así
# que npx (resuelve subiendo directorios) en vez de una ruta fija a web/node_modules/.bin/next.
exec npx next start -p 3000
