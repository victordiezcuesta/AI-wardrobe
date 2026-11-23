import { prisma } from "@/lib/prisma";
import { tooMany } from "@/lib/errors";

/**
 * Ventana fija respaldada por PostgreSQL: funciona entre instancias serverless
 * (un limitador en memoria no sirve en Vercel). Una sola consulta atómica.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<void> {
  const rows = await prisma.$queryRaw<{ count: number; windowStart: Date }[]>`
    INSERT INTO "RateLimit" ("key", "count", "windowStart")
    VALUES (${key}, 1, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."windowStart" < NOW() - (${windowSec} * INTERVAL '1 second') THEN 1 ELSE "RateLimit"."count" + 1 END,
      "windowStart" = CASE WHEN "RateLimit"."windowStart" < NOW() - (${windowSec} * INTERVAL '1 second') THEN NOW() ELSE "RateLimit"."windowStart" END
    RETURNING "count", "windowStart"`;
  const row = rows[0];
  if (row && row.count > limit) {
    const elapsed = Math.floor((Date.now() - row.windowStart.getTime()) / 1000);
    throw tooMany(Math.max(1, windowSec - elapsed));
  }
}

/** Máximo de `limit` y `windowSec` aceptados por rateLimitStatus: el de la columna INTEGER `count` (4 bytes con signo). */
const MAX_STATUS_PARAM = 2_147_483_647;
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_STATUS_PARAM;

/**
 * Consulta de SOLO LECTURA (fase 19.12d): ¿el contador `key` ha alcanzado `limit` en su ventana vigente?
 *  - `true`: existe un contador cuya ventana sigue vigente y cuya cuenta ya es ≥ `limit`; el siguiente
 *    `rateLimit(key, limit, windowSec)` lanzaría 429 (ese intento sería el limit + 1).
 *  - `false`: no existe un contador vigente que haya alcanzado el límite (clave inexistente, ventana expirada o cuenta por
 *    debajo). Con parámetros válidos (enteros ≥ 1), `false` significa que el siguiente intento NO está bloqueado por el
 *    estado observado; con límites menores que 1 `rateLimit` rechaza siempre, por eso no se aceptan.
 *  - Parámetros inválidos (`limit` o `windowSec` que no sean enteros entre 1 y 2 147 483 647): lanza TypeError ANTES de
 *    consultar nada; nunca devuelve `false`.
 * Es una consulta INFORMATIVA: otra petición concurrente puede modificar el contador antes del siguiente `rateLimit()`.
 * Una sola sentencia SELECT: no crea la fila si no existe, no incrementa, no renueva la ventana ni toca ningún campo, y no
 * llama a `rateLimit`. La ventana se evalúa con el mismo reloj (NOW() de PostgreSQL) y la misma regla que `rateLimit`
 * (expirada si windowStart < NOW() − windowSec); es el siguiente `rateLimit` quien abre la ventana nueva. Los errores de
 * base de datos se propagan (sin fallback).
 */
export async function rateLimitStatus(key: string, limit: number, windowSec: number): Promise<boolean> {
  if (!positiveInt(limit)) throw new TypeError("rateLimitStatus: `limit` debe ser un entero positivo");
  if (!positiveInt(windowSec)) throw new TypeError("rateLimitStatus: `windowSec` debe ser un entero positivo");
  const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
    SELECT ("count" >= ${limit} AND "windowStart" >= NOW() - (${windowSec} * INTERVAL '1 second')) AS "blocked"
    FROM "RateLimit" WHERE "key" = ${key}`;
  return rows[0]?.blocked === true;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
