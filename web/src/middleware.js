import { auth } from "@/auth"
import { NextResponse } from "next/server"

// `export { auth as middleware }` a secas SOLO expone la sesión (req.auth), no redirige nada por
// sí mismo -- hay que comprobar req.auth y redirigir a mano, no es automático en Auth.js v5.
export default auth((req) => {
  if (!req.auth) {
    return NextResponse.redirect(new URL("/api/auth/signin", req.url))
  }
})

// Todo excepto las rutas del propio NextAuth (si no, el flujo de login nunca podría completarse),
// los assets estáticos de Next, y /api/agent/* (agent.mjs se autentica con su propio bearer token
// contra server.js -- ver AGENT_TOKEN -- no tiene sesión de Google ni la necesita). El resto
// incluye a propósito /api/state, /api/enqueue, /api/settings (el pipeline) y /api/youtube/*, no
// solo las páginas.
export const config = {
  matcher: ["/((?!api/auth|api/agent|_next/static|_next/image|favicon.ico).*)"],
}
