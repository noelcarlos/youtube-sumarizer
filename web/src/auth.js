import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

// `access_type: offline` + `prompt: consent` son los dos que hacen falta para que Google
// devuelva refresh_token — sin el segundo, un usuario que ya dio consentimiento antes no lo
// vuelve a recibir en logins siguientes (Google solo lo manda la PRIMERA vez que consientes).
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      // Auth.js v5 busca por defecto AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET — este proyecto ya
      // trae GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET en .env (el nombre que da la propia consola
      // de Google Cloud), asi que se pasan explicitos en vez de renombrar variables.
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          access_type: 'offline',
          prompt: 'consent',
          scope: 'openid email profile https://www.googleapis.com/auth/youtube.readonly',
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Solo en el login inicial `account` existe — aqui es donde Google manda el access_token
      // y (si prompt=consent) el refresh_token, que se guardan en el JWT de la sesion.
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at * 1000; // Google lo da en segundos, Date.now() en ms
        return token;
      }

      // Todavia no ha caducado: nada que hacer.
      if (Date.now() < token.expiresAt) return token;

      // Caducado: pedirle a Google un access_token nuevo con el refresh_token guardado. Si esto
      // falla (por ejemplo, el usuario revoco el acceso desde su cuenta de Google), se marca el
      // token con un error para que la UI pueda pedir reconectar en vez de fallar en silencio.
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: token.refreshToken,
          }),
        });
        const refreshed = await res.json();
        if (!res.ok) throw new Error(refreshed.error_description || refreshed.error || `HTTP ${res.status}`);

        token.accessToken = refreshed.access_token;
        token.expiresAt = Date.now() + refreshed.expires_in * 1000;
        // Google no siempre manda un refresh_token nuevo — si no lo manda, se sigue usando el
        // mismo (asi lo documenta Google: es reutilizable hasta que el usuario revoca el acceso).
        if (refreshed.refresh_token) token.refreshToken = refreshed.refresh_token;
        delete token.error;
      } catch (err) {
        token.error = err.message;
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.error = token.error || null;
      return session;
    },
  },
});
