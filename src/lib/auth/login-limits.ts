import { AppError, logError, tooMany } from "@/lib/errors";
import { resolveClientIp } from "@/lib/net/client-ip";
import { rateLimit, rateLimitStatus } from "@/lib/rate-limit";
import { rateLimitByEmail } from "@/lib/rate-limit/email";

/**
 * Fase 19.12e — límites de fuerza bruta del login (Credentials). SOLO Node.js: importa `resolveClientIp` (`node:net`);
 * no debe importarse desde auth/config.ts, el proxy ni código Edge.
 *
 * Orden (lo aplica `enforceLoginLimits`, antes de bcrypt):
 *   1. fallos por IP ya en el límite (consulta, sin incrementar)  → bloqueado
 *   2. intentos por IP, 20 / 60 s                                  → incrementa; bloqueado si supera
 *   3. intentos por IP, 120 / 15 min                               → incrementa; bloqueado si supera
 *   4. intentos por email, 10 / 15 min (clave HMAC `login-email`, 19.15a) → incrementa; bloqueado si supera
 * Un intento bloqueado en un paso no consume los siguientes. Sin IP resoluble (fuera de Vercel o cabecera no válida) se
 * omiten solo los pasos 1-3 (y el contador de fallos). Cualquier error de infraestructura se propaga: fail-closed.
 * Después de bcrypt, `recordLoginFailure` suma un fallo por IP (best-effort) solo si las credenciales eran incorrectas.
 */
export const LOGIN_LIMITS = {
  ipPerMinute: { limit: 20, windowSec: 60 },
  ipPer15Min: { limit: 120, windowSec: 15 * 60 },
  failuresPerIp: { limit: 30, windowSec: 15 * 60 },
  perEmail: { limit: 10, windowSec: 15 * 60 },
} as const;

export const loginKeys = {
  ip1m: (ipKey: string) => `login-ip-1m:${ipKey}`,
  ip15m: (ipKey: string) => `login-ip-15m:${ipKey}`,
  failIp: (ipKey: string) => `login-fail-ip:${ipKey}`,
};

/**
 * Aplica los límites previos a la verificación de credenciales. Devuelve la clave de IP usada (null si no hay IP fiable)
 * o lanza AppError RATE_LIMITED (el llamador lo convierte en el error de login limitado, igual para IP y email).
 */
export async function enforceLoginLimits(email: string, headers: Headers | undefined): Promise<string | null> {
  const ipKey = headers ? resolveClientIp(headers) : null;
  if (ipKey) {
    const f = LOGIN_LIMITS.failuresPerIp;
    if (await rateLimitStatus(loginKeys.failIp(ipKey), f.limit, f.windowSec)) throw tooMany(f.windowSec);
    await rateLimit(loginKeys.ip1m(ipKey), LOGIN_LIMITS.ipPerMinute.limit, LOGIN_LIMITS.ipPerMinute.windowSec);
    await rateLimit(loginKeys.ip15m(ipKey), LOGIN_LIMITS.ipPer15Min.limit, LOGIN_LIMITS.ipPer15Min.windowSec);
  }
  // Clave pseudonimizada (HMAC con AUTH_SECRET, longitud fija): el email nunca se guarda en claro. Sin captura de errores: fail-closed.
  await rateLimitByEmail("login-email", email, LOGIN_LIMITS.perEmail.limit, LOGIN_LIMITS.perEmail.windowSec);
  return ipKey;
}

/**
 * Registra un fallo de credenciales para la IP. BEST-EFFORT: nunca lanza ni cambia el resultado del login (ni «supera el
 * límite» ni un fallo de almacenamiento). Sin IP ni email en el log; solo un aviso genérico si el almacenamiento falla.
 */
export async function recordLoginFailure(ipKey: string | null): Promise<void> {
  if (!ipKey) return;
  const f = LOGIN_LIMITS.failuresPerIp;
  try {
    await rateLimit(loginKeys.failIp(ipKey), f.limit, f.windowSec);
  } catch (e) {
    if (e instanceof AppError && e.code === "RATE_LIMITED") return; // límite alcanzado: lo hará efectivo la consulta del siguiente intento
    logError("auth.login.fail_counter", new Error("No se pudo registrar un fallo de inicio de sesión"));
  }
}
