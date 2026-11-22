import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma as appPrisma } from "@/lib/prisma";

/**
 * Lease del reconciliador de medios (fila única "media-reconcile" de MediaReconcileLock) y ciclo de vida de su ejecución
 * (MediaReconcileRun). Servicio aislado: todavía no lo usa el cron ni escribe en MediaAsset.
 *
 * Garantías:
 * - Reloj: SOLO el de PostgreSQL, `clock_timestamp() AT TIME ZONE 'UTC'` (en UTC, como guarda Prisma las columnas
 *   TIMESTAMP(3)). Nunca fechas calculadas en Node. Toda comprobación temporal se hace DESPUÉS de tener bloqueada la fila
 *   del lock, en una sentencia aparte: si la espera fue por una transacción que solo retuvo la fila (SELECT … FOR UPDATE,
 *   sin modificarla), PostgreSQL no vuelve a evaluar el WHERE de una sentencia que esperó; por eso primero se bloquea y
 *   luego se compara con el reloj real.
 * - Serialización: toda operación bloquea PRIMERO la fila del lock (UPDATE o SELECT … FOR UPDATE) y la mantiene hasta
 *   el final de su transacción; después toca ejecuciones u otras filas de datos. Orden único → sin interbloqueos.
 *   Mientras una operación protegida (withLease) está en curso, otra adquisición espera; cuando entra, la primera ya
 *   no puede renovar (fencing).
 * - Fencing: renovar, operar y liberar exigen a la vez fencingToken, holderRunId y (salvo liberar) lease vigente.
 * - Tokens monotónicos y nunca reutilizados: siguiente = max(token del lock, mayor token de cualquier ejecución) + 1.
 * - Esperas acotadas: lock_timeout por transacción. Agotarlo esperando la fila del lock → BUSY/LOCK_TIMEOUT (nunca
 *   LEASE_LOST); agotarlo dentro de la operación protegida → MediaLeaseError("LOCK_TIMEOUT") tras deshacerla.
 * - Errores sin datos internos: MediaLeaseError solo lleva un código genérico.
 *
 * Comportamiento conocido (no es un lease vigente): recoverAbandoned() puede marcar ABANDONED a la dueña de un lease ya
 * CADUCADO y el lock sigue apuntando a ella hasta la siguiente adquisición, que sustituye dueño y token. Mientras tanto
 * ese lease no se puede renovar ni usar (está caducado y su ejecución ya no está RUNNING); si su proceso llama a release,
 * el lock queda libre con runFinalized=false y la ejecución sigue ABANDONED. No requiere cambios de esquema.
 */
/** Mayor valor de la columna INTEGER fencingToken: superarlo sería un desbordamiento (nunca se reutiliza un token). */
export const MAX_FENCING_TOKEN = 2_147_483_647;
export const MEDIA_RECONCILE_LOCK = "media-reconcile";
const DEFAULT_TTL_MS = 6 * 60_000;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 60 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
/** Ahora según PostgreSQL, en UTC y sin zona (como las columnas TIMESTAMP(3) que escribe Prisma). */
const NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

export type MediaLeaseErrorCode = "INVALID_ARGUMENT" | "LOCK_UNAVAILABLE" | "LOCK_TIMEOUT" | "TOKEN_EXHAUSTED";
/** Error público sin identificadores, tokens ni mensajes de la base de datos. */
export class MediaLeaseError extends Error {
  constructor(readonly code: MediaLeaseErrorCode) { super(`Lease del reconciliador: ${code}`); this.name = "MediaLeaseError"; }
}

export interface MediaLease {
  runId: string;
  fencingToken: number;
  leaseExpiresAt: Date;
  /** Inicio de la ejecución según PostgreSQL (MediaReconcileRun.startedAt). Solo informativo para las operaciones. */
  startedAt?: Date;
}
/** Lease recién adquirido: siempre lleva el startedAt que PostgreSQL guardó en la ejecución. */
export type AcquiredLease = MediaLease & { startedAt: Date };
export type AcquireResult = { status: "ACQUIRED"; lease: AcquiredLease; abandoned: number } | { status: "BUSY"; reason: "LEASE_HELD" | "LOCK_TIMEOUT" };
export type LeaseLost = { ok: false; reason: "LEASE_LOST" };
/** No se pudo obtener la fila del lock a tiempo: el lease NO se ha comprobado (ni perdido); no se ejecutó nada. */
export type LockTimeout = { ok: false; reason: "LOCK_TIMEOUT" };
export type Protected<T> = { ok: true; value: T; leaseExpiresAt: Date } | LeaseLost | LockTimeout;
export type FinalStatus = "COMPLETED" | "INCOMPLETE" | "FAILED";
export interface RunOutcome {
  status: FinalStatus;
  inventoryComplete: boolean;
  /** Informe agregado (sin identificadores). */
  summary?: Prisma.InputJsonValue;
  errorCodes?: string[];
}
export type ReleaseResult = { released: true; runFinalized: boolean } | { released: false; reason: "LEASE_LOST" | "LOCK_TIMEOUT" };
/** Resultado de una ejecución COMPLETA que se cierra con finishWith (estado COMPLETED e inventario completo implícitos). */
export interface FinishOutcome {
  /** Informe agregado (sin identificadores). */
  summary?: Prisma.InputJsonValue;
  errorCodes?: string[];
}
export type Finished<T> = { ok: true; value: T; finishedAt: Date } | LeaseLost | LockTimeout;

type Tx = Prisma.TransactionClient;
type Db = PrismaClient;
interface Opts { ttlMs?: number; lockTimeoutMs?: number }
/**
 * Solo withLease/renew (fase 19.8a): espera máxima para empezar la transacción y duración máxima de la transacción de
 * Prisma. Opcionales y acotados por los valores de TX; sin ellos, exactamente TX (comportamiento anterior).
 */
interface TxOpts { maxWaitMs?: number; timeoutMs?: number }

const LOST: LeaseLost = { ok: false, reason: "LEASE_LOST" };
const LOCK_TIMEOUT: LockTimeout = { ok: false, reason: "LOCK_TIMEOUT" };
class LeaseLostSignal extends Error {}

function ttlOf(ms: number | undefined): number {
  const v = ms ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(v) || v < MIN_TTL_MS || v > MAX_TTL_MS) throw new MediaLeaseError("INVALID_ARGUMENT");
  return v;
}
function lockTimeoutOf(ms: number | undefined): number {
  const v = ms ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(v) || v < 1 || v > 60_000) throw new MediaLeaseError("INVALID_ARGUMENT");
  return v;
}
function checkCodes(codes: unknown): string[] {
  const list = codes ?? [];
  if (!Array.isArray(list) || list.length > 64 || !list.every((c) => typeof c === "string" && c.length > 0 && c.length <= 120)) {
    throw new MediaLeaseError("INVALID_ARGUMENT");
  }
  return list as string[];
}
function checkLease(lease: MediaLease) {
  if (!lease || typeof lease.runId !== "string" || lease.runId === "" || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1) {
    throw new MediaLeaseError("INVALID_ARGUMENT");
  }
}
/** El tiempo máximo de espera por un bloqueo, solo para ESTA transacción (parametrizado, sin interpolar). */
async function boundWaits(tx: Tx, lockTimeoutMs: number) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
}
/**
 * lock_timeout de PostgreSQL (SQLSTATE 55P03), reconocido SOLO por su estructura: un PrismaClientKnownRequestError cuyo
 * error del adaptador es de PostgreSQL con ese código (forma real con Prisma 7 + adaptador: código P2010 y
 * meta.driverAdapterError.cause = { kind: "postgres", code / originalCode: "55P03" }). Nunca por el texto del mensaje: un
 * error cualquiera de la operación protegida que mencione «55P03» o «lock timeout» se propaga como error propio.
 */
const isLockTimeout = (e: unknown): boolean => {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (e.meta as { driverAdapterError?: { cause?: { kind?: unknown; code?: unknown; originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.kind === "postgres" && (cause.originalCode === "55P03" || cause.code === "55P03");
};
const TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 30_000 } as const;
/** Opciones de transacción de withLease: TX, o valores menores validados (1 ms … el de TX). */
function txOf(opts: TxOpts): typeof TX | { isolationLevel: typeof TX.isolationLevel; maxWait: number; timeout: number } {
  if (opts.maxWaitMs === undefined && opts.timeoutMs === undefined) return TX;
  const bounded = (v: number | undefined, max: number) => {
    if (v === undefined) return max;
    if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new MediaLeaseError("INVALID_ARGUMENT");
    return v;
  };
  return { isolationLevel: TX.isolationLevel, maxWait: bounded(opts.maxWaitMs, TX.maxWait), timeout: bounded(opts.timeoutMs, TX.timeout) };
}

export function createMediaLease(db: Db) {
  /** Bloquea la fila del lock hasta el final de `tx` (aquí es donde se espera). false si la fila no existe. */
  async function lockRowIn(tx: Tx): Promise<boolean> {
    const rows = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM "MediaReconcileLock" WHERE "name" = ${MEDIA_RECONCILE_LOCK} FOR UPDATE`;
    return rows.length === 1;
  }

  /**
   * Renueva el lease DENTRO de la transacción `tx`. 1) Bloquea la fila del lock (puede esperar). 2) Ya con la fila
   * bloqueada, sin esperas posibles, comprueba token, dueño y vigencia con clock_timestamp() en el propio WHERE y fija la
   * nueva expiración. 3) La ejecución dueña debe seguir RUNNING: si no se actualiza exactamente una, el lease se da por
   * perdido y quien llama deshace toda la transacción (también la renovación). null → lease perdido.
   */
  async function renewIn(tx: Tx, lease: MediaLease, ttlMs: number): Promise<Date | null> {
    if (!(await lockRowIn(tx))) return null;
    const rows = await tx.$queryRaw<{ leaseExpiresAt: Date; heartbeatAt: Date }[]>`
      UPDATE "MediaReconcileLock"
         SET "heartbeatAt" = ${NOW}, "updatedAt" = ${NOW}, "leaseExpiresAt" = ${NOW} + (${ttlMs}::float8 * interval '1 millisecond')
       WHERE "name" = ${MEDIA_RECONCILE_LOCK} AND "fencingToken" = ${lease.fencingToken} AND "holderRunId" = ${lease.runId}
         AND "leaseExpiresAt" > ${NOW}
      RETURNING "leaseExpiresAt", "heartbeatAt"`;
    if (rows.length !== 1) return null;
    const touched = await tx.$executeRaw`UPDATE "MediaReconcileRun" SET "heartbeatAt" = GREATEST("heartbeatAt", ${rows[0]!.heartbeatAt}::timestamp), "updatedAt" = ${NOW}
      WHERE "id" = ${lease.runId} AND "status" = 'RUNNING'`;
    if (touched !== 1) throw new LeaseLostSignal();
    return rows[0]!.leaseExpiresAt;
  }

  /** Marca ABANDONED todas las ejecuciones RUNNING salvo `keepRunId` (la dueña de un lease vigente). Requiere el lock bloqueado. */
  async function abandonIn(tx: Tx, keepRunId: string | null): Promise<number> {
    return tx.$executeRaw`
      WITH t AS (SELECT ${NOW} AS ts)
      UPDATE "MediaReconcileRun" AS r
         SET "status" = 'ABANDONED', "finishedAt" = GREATEST(t.ts, r."startedAt"), "heartbeatAt" = LEAST(r."heartbeatAt", GREATEST(t.ts, r."startedAt")),
             "updatedAt" = t.ts
        FROM t
       WHERE r."status" = 'RUNNING' AND r."id" IS DISTINCT FROM ${keepRunId}`;
  }

  /**
   * Operación protegida: en UNA transacción, renueva el lease (comprueba y bloquea la fila del lock) y, solo si sigue
   * siendo suyo, ejecuta `fn` con esa misma transacción. La fila del lock queda bloqueada hasta el final: ninguna
   * adquisición puede colarse entre la comprobación y las escrituras. Orden: lock → filas de datos.
   */
  async function withLease<T>(lease: MediaLease, fn: (tx: Tx) => Promise<T>, opts: Opts & TxOpts = {}): Promise<Protected<T>> {
    checkLease(lease);
    const ttlMs = ttlOf(opts.ttlMs);
    const lockTimeoutMs = lockTimeoutOf(opts.lockTimeoutMs);
    const txOpts = txOf(opts);
    let phase: "lock" | "fn" = "lock";
    try {
      return await db.$transaction(async (tx) => {
        await boundWaits(tx, lockTimeoutMs);
        const leaseExpiresAt = await renewIn(tx, lease, ttlMs);
        if (!leaseExpiresAt) throw new LeaseLostSignal();
        phase = "fn";
        return { ok: true as const, value: await fn(tx), leaseExpiresAt };
      }, txOpts);
    } catch (e) {
      if (e instanceof LeaseLostSignal) return LOST;
      if (isLockTimeout(e)) {
        if (phase === "lock") return LOCK_TIMEOUT; // no se llegó a comprobar el lease: no se ejecutó nada
        throw new MediaLeaseError("LOCK_TIMEOUT"); // dentro de la operación protegida: deshecha entera, sin datos internos
      }
      throw e;
    }
  }

  /**
   * Cierra una ejecución COMPLETA de forma atómica: en UNA transacción, (1) bloquea la fila del lock y, ya bloqueada,
   * comprueba token, dueño y lease vigente con clock_timestamp(); (2) bloquea la ejecución y exige que siga RUNNING;
   * (3) ejecuta `fn` con esa misma transacción (p. ej. la persistencia de MediaAsset); (4) cierra la ejecución como
   * COMPLETED con su resumen; (5) libera el lock. Orden de bloqueo: lock → ejecución → filas de datos.
   * Cualquier fallo (de `fn`, del cierre o de la liberación) deshace TODO: ni datos de `fn`, ni cierre, ni liberación.
   * Lease perdido, ejecución que ya no está RUNNING (ABANDONED, o ya finalizada) → LEASE_LOST sin ejecutar `fn`.
   */
  async function finishWith<T>(lease: MediaLease, outcome: FinishOutcome, fn: (tx: Tx) => Promise<T>, opts: Pick<Opts, "lockTimeoutMs"> = {}): Promise<Finished<T>> {
    checkLease(lease);
    const lockTimeoutMs = lockTimeoutOf(opts.lockTimeoutMs);
    if (!outcome || typeof outcome !== "object") throw new MediaLeaseError("INVALID_ARGUMENT");
    const codes = checkCodes(outcome.errorCodes);
    const summary = outcome.summary === undefined ? null : JSON.stringify(outcome.summary);
    let phase: "lock" | "fn" = "lock";
    try {
      return await db.$transaction(async (tx): Promise<Finished<T>> => {
        await boundWaits(tx, lockTimeoutMs);
        // (1) Lock bloqueado ANTES de mirar la hora; después, comprobación con el reloj real.
        if (!(await lockRowIn(tx))) throw new LeaseLostSignal();
        const owned = await tx.$queryRaw<{ one: number }[]>`
          SELECT 1 AS one FROM "MediaReconcileLock"
           WHERE "name" = ${MEDIA_RECONCILE_LOCK} AND "fencingToken" = ${lease.fencingToken} AND "holderRunId" = ${lease.runId}
             AND "leaseExpiresAt" > ${NOW}`;
        if (owned.length !== 1) throw new LeaseLostSignal();
        // (2) La ejecución sigue RUNNING (ni ABANDONED ni ya finalizada) y queda bloqueada hasta el final.
        const running = await tx.$queryRaw<{ one: number }[]>`
          SELECT 1 AS one FROM "MediaReconcileRun" WHERE "id" = ${lease.runId} AND "status" = 'RUNNING' FOR UPDATE`;
        if (running.length !== 1) throw new LeaseLostSignal();
        // (3) Operación protegida.
        phase = "fn";
        const value = await fn(tx);
        // (4) Cierre COMPLETED (inventario completo) con la hora de PostgreSQL.
        const [closed] = await tx.$queryRaw<{ finishedAt: Date }[]>`
          UPDATE "MediaReconcileRun"
             SET "status" = 'COMPLETED', "complete" = true, "inventoryComplete" = true, "summary" = ${summary}::jsonb,
                 "errorCodes" = ${codes}::text[], "finishedAt" = GREATEST(${NOW}, "startedAt"),
                 "heartbeatAt" = LEAST("heartbeatAt", GREATEST(${NOW}, "startedAt")), "updatedAt" = ${NOW}
           WHERE "id" = ${lease.runId} AND "status" = 'RUNNING'
          RETURNING "finishedAt"`;
        if (!closed) throw new LeaseLostSignal(); // imposible con la fila bloqueada; por si acaso, se deshace todo
        // (5) Liberación del lock (sigue bloqueado por esta transacción: token y dueño no han podido cambiar).
        const freed = await tx.$executeRaw`
          UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = ${NOW}, "updatedAt" = ${NOW}
           WHERE "name" = ${MEDIA_RECONCILE_LOCK} AND "fencingToken" = ${lease.fencingToken} AND "holderRunId" = ${lease.runId}`;
        if (freed !== 1) throw new LeaseLostSignal();
        return { ok: true, value, finishedAt: closed.finishedAt };
      }, TX);
    } catch (e) {
      if (e instanceof LeaseLostSignal) return LOST;
      if (isLockTimeout(e)) {
        if (phase === "lock") return LOCK_TIMEOUT; // no se llegó a comprobar el lease: no se ejecutó nada
        throw new MediaLeaseError("LOCK_TIMEOUT"); // dentro de fn o del cierre: deshecho entero, sin datos internos
      }
      throw e;
    }
  }

  return {
    /**
     * Adquiere el lease y crea su ejecución en UNA transacción: bloquea la fila del lock (FOR UPDATE; una adquisición
     * concurrente espera y, al entrar, ve el lease ya tomado), comprueba con el reloj de PostgreSQL que está libre o
     * caducado, marca ABANDONED las ejecuciones RUNNING que se quedaron sin lease, crea la ejecución con el token
     * siguiente y asigna el lease. Cualquier fallo deshace todo.
     */
    async acquire(opts: Opts & { graceHours: number; codeVersion?: string | null }): Promise<AcquireResult> {
      const ttlMs = ttlOf(opts.ttlMs);
      const lockTimeoutMs = lockTimeoutOf(opts.lockTimeoutMs);
      if (typeof opts.graceHours !== "number" || !(opts.graceHours >= 1 && opts.graceHours <= 8760)) throw new MediaLeaseError("INVALID_ARGUMENT");
      const codeVersion = opts.codeVersion ?? null;
      if (codeVersion !== null && (typeof codeVersion !== "string" || codeVersion.length < 1 || codeVersion.length > 64)) throw new MediaLeaseError("INVALID_ARGUMENT");
      try {
        return await db.$transaction(async (tx): Promise<AcquireResult> => {
          await boundWaits(tx, lockTimeoutMs);
          // 1) Bloquear la fila (aquí se espera). 2) Ya bloqueada, decidir con el reloj real si está libre.
          const lockRow = async () => {
            if (!(await lockRowIn(tx))) return undefined;
            const [row] = await tx.$queryRaw<{ fencingToken: number; free: boolean }[]>`
              SELECT "fencingToken", ("holderRunId" IS NULL OR "leaseExpiresAt" <= ${NOW}) AS free
                FROM "MediaReconcileLock" WHERE "name" = ${MEDIA_RECONCILE_LOCK}`;
            return row;
          };
          let lock = await lockRow();
          if (!lock) {
            // La fila desapareció: se vuelve a crear SIN reiniciar la secuencia (nunca se reutiliza un token).
            await tx.$executeRaw`INSERT INTO "MediaReconcileLock" ("name", "fencingToken", "createdAt", "updatedAt")
              SELECT ${MEDIA_RECONCILE_LOCK}, COALESCE(MAX("fencingToken"), 0), ${NOW}, ${NOW} FROM "MediaReconcileRun"
              ON CONFLICT ("name") DO NOTHING`;
            lock = await lockRow();
            if (!lock) throw new MediaLeaseError("LOCK_UNAVAILABLE");
          }
          if (!lock.free) return { status: "BUSY", reason: "LEASE_HELD" };
          // Token siguiente en BIGINT: si superaría INTEGER, error controlado ANTES de modificar nada (la transacción se deshace).
          const [next] = await tx.$queryRaw<{ token: bigint }[]>`
            SELECT GREATEST(${lock.fencingToken}::bigint, COALESCE((SELECT MAX("fencingToken") FROM "MediaReconcileRun"), 0)::bigint) + 1 AS token`;
          const token = Number(next!.token);
          if (!Number.isSafeInteger(token) || token > MAX_FENCING_TOKEN) throw new MediaLeaseError("TOKEN_EXHAUSTED");
          const abandoned = await abandonIn(tx, null); // el lock está libre: ninguna ejecución RUNNING tiene un lease vigente
          const [created] = await tx.$queryRaw<{ id: string; fencingToken: number; ts: Date }[]>`
            WITH t AS (SELECT ${NOW} AS ts)
            INSERT INTO "MediaReconcileRun" ("id", "kind", "status", "fencingToken", "startedAt", "heartbeatAt", "graceHours", "codeVersion", "updatedAt")
            SELECT gen_random_uuid()::text, 'DETECT', 'RUNNING', ${token}::int, t.ts, t.ts, ${opts.graceHours}::float8, ${codeVersion}, t.ts FROM t
            RETURNING "id", "fencingToken", "startedAt" AS ts`;
          const [held] = await tx.$queryRaw<{ leaseExpiresAt: Date }[]>`
            UPDATE "MediaReconcileLock"
               SET "fencingToken" = ${created!.fencingToken}, "holderRunId" = ${created!.id},
                   "leaseExpiresAt" = ${created!.ts}::timestamp + (${ttlMs}::float8 * interval '1 millisecond'),
                   "heartbeatAt" = ${created!.ts}::timestamp, "updatedAt" = ${created!.ts}::timestamp
             WHERE "name" = ${MEDIA_RECONCILE_LOCK}
            RETURNING "leaseExpiresAt"`;
          return {
            status: "ACQUIRED", abandoned,
            lease: { runId: created!.id, fencingToken: created!.fencingToken, leaseExpiresAt: held!.leaseExpiresAt, startedAt: created!.ts },
          };
        }, TX);
      } catch (e) {
        if (isLockTimeout(e)) return { status: "BUSY", reason: "LOCK_TIMEOUT" };
        throw e;
      }
    },

    withLease,

    finishWith,

    /** Renueva el lease (heartbeat). LEASE_LOST si otro proceso lo tiene, caducó o el token/dueño no coinciden. */
    async renew(lease: MediaLease, opts: Opts = {}): Promise<Protected<undefined>> {
      return withLease(lease, async () => undefined, opts); // referencia directa: funciona aunque se desestructure
    },

    /**
     * Libera el lease y cierra la ejecución, solo si token y dueño coinciden (aunque el lease haya caducado, mientras
     * nadie lo haya adquirido después). Dueño y expiración pasan a NULL a la vez; la ejecución RUNNING queda terminada.
     */
    async release(lease: MediaLease, outcome: RunOutcome, opts: Pick<Opts, "lockTimeoutMs"> = {}): Promise<ReleaseResult> {
      checkLease(lease);
      const lockTimeoutMs = lockTimeoutOf(opts.lockTimeoutMs);
      const statusOk = ["COMPLETED", "INCOMPLETE", "FAILED"].includes(outcome?.status);
      if (!statusOk || typeof outcome.inventoryComplete !== "boolean" || (outcome.status === "COMPLETED" && !outcome.inventoryComplete)) {
        throw new MediaLeaseError("INVALID_ARGUMENT");
      }
      const codes = checkCodes(outcome.errorCodes);
      try {
        return await db.$transaction(async (tx): Promise<ReleaseResult> => {
          await boundWaits(tx, lockTimeoutMs);
          const [freed] = await tx.$queryRaw<{ ts: Date }[]>`
            WITH t AS (SELECT ${NOW} AS ts)
            UPDATE "MediaReconcileLock" AS l SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = t.ts, "updatedAt" = t.ts
              FROM t
             WHERE l."name" = ${MEDIA_RECONCILE_LOCK} AND l."fencingToken" = ${lease.fencingToken} AND l."holderRunId" = ${lease.runId}
            RETURNING t.ts`;
          if (!freed) return { released: false, reason: "LEASE_LOST" };
          const summary = outcome.summary === undefined ? null : JSON.stringify(outcome.summary);
          const finalized = await tx.$executeRaw`
            UPDATE "MediaReconcileRun"
               SET "status" = ${outcome.status}::"MediaReconcileRunStatus", "complete" = ${outcome.status === "COMPLETED"},
                   "inventoryComplete" = ${outcome.inventoryComplete}, "summary" = ${summary}::jsonb, "errorCodes" = ${codes}::text[],
                   "finishedAt" = GREATEST(${freed.ts}::timestamp, "startedAt"),
                   "heartbeatAt" = LEAST("heartbeatAt", GREATEST(${freed.ts}::timestamp, "startedAt")), "updatedAt" = ${freed.ts}::timestamp
             WHERE "id" = ${lease.runId} AND "status" = 'RUNNING'`;
          return { released: true, runFinalized: finalized === 1 };
        }, TX);
      } catch (e) {
        if (isLockTimeout(e)) return { released: false, reason: "LOCK_TIMEOUT" }; // nada cambió: se puede reintentar
        throw e;
      }
    },

    /**
     * Recupera ejecuciones RUNNING sin lease vigente y las marca ABANDONED. Bloquea antes la fila del lock (se serializa
     * con adquisiciones y renovaciones) y respeta a la dueña de un lease vigente. Las terminales no se tocan.
     */
    async recoverAbandoned(opts: Pick<Opts, "lockTimeoutMs"> = {}): Promise<number> {
      const lockTimeoutMs = lockTimeoutOf(opts.lockTimeoutMs);
      try {
        return await db.$transaction(async (tx) => {
          await boundWaits(tx, lockTimeoutMs);
          // Sin la fila del lock no hay serialización posible con las adquisiciones: no se toca nada.
          if (!(await lockRowIn(tx))) return 0;
          const [lock] = await tx.$queryRaw<{ activeHolder: string | null }[]>`
            SELECT CASE WHEN "leaseExpiresAt" > ${NOW} THEN "holderRunId" END AS "activeHolder"
              FROM "MediaReconcileLock" WHERE "name" = ${MEDIA_RECONCILE_LOCK}`;
          return abandonIn(tx, lock!.activeHolder);
        }, TX);
      } catch (e) {
        if (isLockTimeout(e)) throw new MediaLeaseError("LOCK_TIMEOUT");
        throw e;
      }
    },
  };
}

export type MediaLeaseService = ReturnType<typeof createMediaLease>;
/** Instancia de la aplicación (cliente de Prisma compartido). */
export const mediaLeaseService: MediaLeaseService = createMediaLease(appPrisma as Db);
