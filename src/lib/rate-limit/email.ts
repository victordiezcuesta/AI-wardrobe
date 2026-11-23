import { createHmac } from "node:crypto";
import { env } from "@/lib/env";
import { rateLimit } from "./index";

/**
 * Fase 19.13a (login en 19.15a) — rate limiting por EMAIL con claves pseudonimizadas: registro (`register-email`), recuperación
 * de contraseña (`forgot-email`) e inicio de sesión (`login-email`). SOLO Node.js (`node:crypto`).
 *
 * Clave: `<scope>:<32 hex>`, donde
 *   subclave = HMAC-SHA256(AUTH_SECRET, "rate-limit:email-key:v1")            (separación de dominio)
 *   hash     = HMAC-SHA256(subclave, "<scope>:<email normalizado>").hex.slice(0, 32)   (128 bits)
 * El scope entra también en el mensaje firmado: el mismo email da hashes DISTINTOS en cada scope, así que no se pueden
 * correlacionar las filas de registro y de recuperación de un mismo email. El email nunca aparece en la clave (ni «@»),
 * la longitud es fija sea cual sea el email y, sin AUTH_SECRET, no se puede confirmar por fuerza bruta si un email está en
 * la tabla (un SHA-256 sin secreto sí lo permitiría). El scope `login-email` sustituye a las claves `login:<email>` en claro
 * (19.15a); las filas antiguas no se migran: caducan y las elimina la purga de RateLimit. Rotar AUTH_SECRET reinicia estos contadores (también invalida las
 * sesiones, así que no es un coste añadido). Sin variables nuevas.
 *
 * El helper NO comprueba si existe la cuenta (el contador sube para cualquier email, existente o no: nada que enumerar),
 * no captura errores (los de almacenamiento llegan tal cual: fail-closed) y no registra nada en logs. El llamador pasa el
 * email ya validado por Zod (recortado, en minúsculas y con formato válido); aquí solo se reaplica esa misma
 * normalización (idempotente) para que dos formas del mismo email nunca generen contadores distintos.
 */
export const EMAIL_RATE_SCOPES = ["register-email", "forgot-email", "login-email"] as const;
export type EmailRateScope = (typeof EMAIL_RATE_SCOPES)[number];

const KEY_DERIVATION_CONTEXT = "rate-limit:email-key:v1";
const HASH_HEX_LENGTH = 32; // 128 bits
const MIN_SECRET_LENGTH = 16; // el mismo mínimo que exige el esquema de entorno para AUTH_SECRET
const MAX_PARAM = 2_147_483_647;

const isScope = (v: unknown): v is EmailRateScope => typeof v === "string" && (EMAIL_RATE_SCOPES as readonly string[]).includes(v);
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PARAM;

/** Misma normalización que los esquemas de email (recorte y minúsculas). */
function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") throw new TypeError("rateLimitByEmail: `email` debe ser texto");
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) throw new TypeError("rateLimitByEmail: `email` no puede estar vacío");
  return normalized;
}

/** Clave de rate limiting del email para un scope permitido. Lanza TypeError ante scope o email no válidos. */
export function emailRateKey(scope: EmailRateScope, email: string): string {
  if (!isScope(scope)) throw new TypeError("rateLimitByEmail: `scope` no permitido");
  const normalized = normalizeEmail(email);
  const secret = env().AUTH_SECRET; // env() valida el entorno y lanza (sin valores) si falta o es inválido
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw new Error("rateLimitByEmail: AUTH_SECRET no disponible o inválido");
  const subkey = createHmac("sha256", secret).update(KEY_DERIVATION_CONTEXT).digest();
  const hash = createHmac("sha256", subkey).update(`${scope}:${normalized}`).digest("hex").slice(0, HASH_HEX_LENGTH);
  return `${scope}:${hash}`;
}

/**
 * Cuenta una petición para el email y rechaza (429, vía `rateLimit`) al superar `limit` en `windowSec`. Una sola llamada a
 * `rateLimit`; devuelve su resultado y propaga sus errores sin alterarlos.
 */
export async function rateLimitByEmail(scope: EmailRateScope, email: string, limit: number, windowSec: number): ReturnType<typeof rateLimit> {
  // Toda la validación ocurre ANTES de cualquier acceso a la base de datos; un argumento inválido nunca llega al limitador.
  if (!isScope(scope)) throw new TypeError("rateLimitByEmail: `scope` no permitido");
  if (!positiveInt(limit)) throw new TypeError("rateLimitByEmail: `limit` debe ser un entero positivo");
  if (!positiveInt(windowSec)) throw new TypeError("rateLimitByEmail: `windowSec` debe ser un entero positivo");
  const key = emailRateKey(scope, email);
  return rateLimit(key, limit, windowSec);
}
