import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { AppError, logError } from "@/lib/errors";
import { LOGIN_RATE_LIMITED_CODE } from "@/features/authentication/login-errors";
import { authConfig } from "./config";
import { loginSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { sessionService } from "@/services/session.service";
import { enforceLoginLimits, recordLoginFailure } from "./login-limits";

/** Límite de intentos de login superado. Llega al cliente como `error=CredentialsSignin&code=rate_limited`. */
export class LoginRateLimited extends CredentialsSignin {
  code = LOGIN_RATE_LIMITED_CODE;
}

/**
 * Configuración completa (solo Node: usa Prisma). El proxy usa `authConfig` (edge, sin base de datos) y solo comprueba
 * que el JWT es válido; la revocación real se comprueba aquí, en cada `auth()` de páginas y Route Handlers.
 */
export const authOptions = {
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw, request) {
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        let ipKey: string | null;
        try {
          // Límites por IP (si hay IP fiable) y por email, ANTES de bcrypt (ver login-limits.ts). Auth.js convierte cualquier
          // error que no sea suyo en `error=Configuration`; el límite superado debe llegar al cliente como CredentialsSignin
          // con su propio código, igual si lo causa la IP o el email y exista o no la cuenta. Otros errores (infraestructura)
          // siguen siendo internos: fail-closed, bcrypt no llega a ejecutarse.
          ipKey = await enforceLoginLimits(email, request?.headers);
        } catch (e) {
          if (e instanceof AppError && e.code === "RATE_LIMITED") throw new LoginRateLimited();
          throw e;
        }
        // verifyCredentials devuelve null SOLO para credenciales no válidas (sin usuario, contraseña incorrecta o email sin
        // confirmar: indistinguibles a propósito) y LANZA ante errores internos, que no llegan al contador de fallos.
        const user = await authService.verifyCredentials(email, password);
        if (!user) await recordLoginFailure(ipKey);
        return user;
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    /**
     * Inicio de sesión (`user` presente): crea la fila `Session` y guarda su `sid` en el JWT.
     * Resto de llamadas: el JWT solo vale si su sesión sigue existiendo y no ha caducado. Devolver `null`
     * hace que Auth.js trate la sesión como inexistente (y borre la cookie cuando puede escribirla).
     */
    async jwt(params) {
      const token = authConfig.callbacks.jwt(params);
      if (params.user?.id) {
        token.sid = await sessionService.start(params.user.id);
        return token;
      }
      return (await sessionService.validate(token)) ? token : null;
    },
  },
  events: {
    /**
     * Refuerzo para quien llame directamente a /api/auth/signout. El flujo de la app revoca antes en
     * POST /api/auth/logout, porque Auth.js ignora (solo registra) los errores de este evento.
     */
    async signOut(message) {
      if ("token" in message && message.token) {
        await sessionService.revoke(message.token.sid).catch((e) => logError("auth.signout.revoke", e));
      }
    },
  },
} satisfies NextAuthConfig;

// Solo se exportan handlers (rutas de Auth.js) y auth(). El logout se hace en dos pasos (POST /api/auth/logout y
// signOut de next-auth/react); un signOut de servidor no revocaría antes la sesión en Neon.
export const { handlers, auth } = NextAuth(authOptions);
