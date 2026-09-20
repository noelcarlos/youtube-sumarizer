import { auth } from "@/auth"
import { NextResponse } from "next/server"

// `export { auth as middleware }` a secas SOLO expone la sesión (req.auth), no redirige nada por
// sí mismo -- hay que comprobar req.auth y redirigir a mano, no es automático en Auth.js v5.
export default auth((req) => {
  if (!req.auth) {
    return NextResponse.redirect(new URL("/api/auth/signin", req.url))
  }
})

// Todo excepto las rutas del propio NextAuth (si no, el flujo de login nunca podría completarse)
// y los assets estáticos de Next -- incluye a propósito /api/state, /api/enqueue, /api/settings
// (el pipeline) y /api/youtube/*, no solo las páginas.
export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
}
