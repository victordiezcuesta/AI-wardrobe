import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Fase 19.14b — purga de filas caducadas de `RateLimit`. Sin parámetros de configuración: retención, tamaño de lote, número
 * de lotes y presupuesto son constantes privadas (nada de esto puede venir de una petición).
 *
 * Criterio: `windowStart < NOW() − 24 h`. `rateLimit` solo cambia `windowStart` al ABRIR una ventana nueva, así que una fila
 * con `windowStart` de hace más de 24 h lleva al menos 23 h con su ventana expirada (la máxima en uso es de 3600 s) y su
 * siguiente golpe la reiniciaría a `count = 1`: borrarla es equivalente a ese reinicio. Debe cumplirse siempre
 * RETENTION > ventana máxima de cualquier llamada a `rateLimit` (lo vigila tests/unit/rate-limit-windows-guard.test.ts).
 *
 * Cada lote es UNA sentencia atómica (CTE + DELETE … USING) dentro de una transacción con statement_timeout y lock_timeout
 * locales:
 *  - la selección va ordenada por `windowStart` (usa RateLimit_windowStart_idx) y acotada a BATCH_SIZE;
 *  - `FOR UPDATE SKIP LOCKED`: dos purgas simultáneas reparten filas distintas sin esperarse ni borrar dos veces;
 *  - el DELETE REPITE la condición de antigüedad: si `rateLimit` refresca una fila entre su selección y el borrado, esa fila
 *    ya no cumple la condición y se conserva (su contador nuevo no se pierde).
 * Idempotente: una ejecución sin filas caducadas no borra nada. Sin logs: nunca se registran claves ni datos.
 *
 * `complete` (19.14b.1): `FOR UPDATE SKIP LOCKED` salta las filas que otra transacción tiene bloqueadas, así que un lote con
 * menos de BATCH_SIZE filas NO prueba que no quede nada. Por eso, cuando un lote devuelve menos de BATCH_SIZE, el MISMO
 * lote (misma transacción) ejecuta una comprobación de solo lectura —`SELECT EXISTS` con el mismo criterio de retención, sin
 * FOR UPDATE— que sí ve las filas bloqueadas. `complete` es true únicamente si, tras el último borrado, esa comprobación no
 * encuentra ninguna fila caducada (ni bloqueada ni nueva). Si encuentra alguna, `complete` es false: queda para la siguiente
 * ejecución (no se espera ni se reintenta, para no introducir esperas).
 */
const RETENTION_HOURS = 24;
const BATCH_SIZE = 5_000;
const MAX_BATCHES = 20;
const BUDGET_MS = 25_000;
/**
 * Cotas por sentencia y por transacción. El tiempo de un lote es una COTA ESTIMADA, no una garantía absoluta:
 *   esperar conexión (maxWait) + vida de la transacción (timeout, tras el cual Prisma pide ROLLBACK) + una sentencia que ya
 *   estuviera en vuelo cuando vence ese plazo (hasta statement_timeout; el ROLLBACK espera detrás) + COMMIT/ROLLBACK.
 * Un lote solo empieza si su cota cabe entera en el presupuesto restante; así, bajo esas hipótesis, la ejecución completa no
 * pasa de BUDGET_MS. Fuera de ellas (red colgada, fallos del cliente) el tope duro es el maxDuration de la ruta que la invoque.
 */
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 2_000;
const TX_MAX_WAIT_MS = 2_000;
const TX_TIMEOUT_MS = 8_000;
const TX_SLACK_MS = 2_000; // COMMIT/ROLLBACK
const BATCH_MAX_MS = TX_MAX_WAIT_MS + TX_TIMEOUT_MS + STATEMENT_TIMEOUT_MS + TX_SLACK_MS; // 17 s

export interface RateLimitPurgeResult {
  /** Filas eliminadas en esta ejecución. */
  deleted: number;
  /** Lotes ejecutados. */
  batches: number;
  /**
   * true: tras el último borrado, una comprobación de solo lectura en la misma transacción NO encontró ninguna fila caducada
   * (tampoco bloqueadas por otras transacciones). false: se alcanzó MAX_BATCHES o el presupuesto, o quedan filas caducadas
   * (p. ej. saltadas por SKIP LOCKED): todavía hay trabajo para la siguiente ejecución.
   */
  complete: boolean;
}

const cutoff = () => Prisma.sql`NOW() - (${RETENTION_HOURS} * INTERVAL '1 hour')`;
const expiredSelection = () => Prisma.sql`SELECT "key" FROM "RateLimit"
   WHERE "windowStart" < ${cutoff()}
   ORDER BY "windowStart"
   LIMIT ${BATCH_SIZE}
     FOR UPDATE SKIP LOCKED`;

/**
 * Sentencia de UN lote. `selection` solo existe para que las pruebas simulen de forma determinista una selección «vieja»
 * (una fila refrescada después de seleccionarse); el servicio nunca la recibe de fuera.
 */
export function purgeBatchSql(selection: Prisma.Sql = expiredSelection()): Prisma.Sql {
  return Prisma.sql`WITH doomed AS (${selection})
    DELETE FROM "RateLimit" r USING doomed d
     WHERE r."key" = d."key" AND r."windowStart" < ${cutoff()}`;
}

/**
 * Comprobación de SOLO LECTURA (sin FOR UPDATE, sin bloquear nada): ¿queda alguna fila caducada, incluidas las que otra
 * transacción tiene bloqueadas? Un SELECT ordinario las ve (MVCC) aunque SKIP LOCKED las haya saltado. Solo devuelve un booleano.
 */
export function expiredRowsRemainSql(): Prisma.Sql {
  return Prisma.sql`SELECT EXISTS (SELECT 1 FROM "RateLimit" WHERE "windowStart" < ${cutoff()}) AS "pending"`;
}

async function runBatch(): Promise<{ deleted: number; pending: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${STATEMENT_TIMEOUT_MS}ms`}, true), set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true)`;
    const deleted = await tx.$executeRaw(purgeBatchSql());
    // Un lote lleno ya implica que puede haber más; con menos de BATCH_SIZE hay que COMPROBAR (SKIP LOCKED pudo saltar filas).
    if (deleted >= BATCH_SIZE) return { deleted, pending: true };
    const [row] = await tx.$queryRaw<{ pending: boolean }[]>(expiredRowsRemainSql());
    return { deleted, pending: row?.pending !== false }; // ante cualquier duda sobre la respuesta, NO se declara completa
  }, { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS });
}

/**
 * Borra las filas caducadas por lotes de 5000, con un máximo de 20 lotes y 25 s por ejecución. Si un lote falla, el error se
 * propaga tal cual (los lotes ya confirmados se conservan: cada uno es atómico). `opts.clock` solo permite inyectar el reloj
 * en pruebas.
 */
export async function purgeExpiredRateLimits(opts: { clock?: () => number } = {}): Promise<RateLimitPurgeResult> {
  const clock = opts.clock ?? (() => Date.now());
  const t0 = clock();
  const result: RateLimitPurgeResult = { deleted: 0, batches: 0, complete: false };
  while (result.batches < MAX_BATCHES) {
    if (clock() - t0 + BATCH_MAX_MS > BUDGET_MS) return result; // sin tiempo para otro lote entero
    const { deleted, pending } = await runBatch();
    result.deleted += deleted;
    result.batches++;
    if (!pending) { result.complete = true; return result; }
    // Con menos de BATCH_SIZE y filas pendientes, estas están bloqueadas por otra transacción (o acaban de caducar): no se
    // espera ni se insiste, se deja para la siguiente ejecución.
    if (deleted < BATCH_SIZE) return result;
  }
  return result; // MAX_BATCHES: puede quedar trabajo
}
