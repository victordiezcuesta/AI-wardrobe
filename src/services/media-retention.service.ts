import { Prisma } from "@/generated/prisma/client";
import { logError } from "@/lib/errors";
import { isDbError } from "@/lib/errors/db";
import { MediaLeaseError, type MediaLease, type MediaLeaseService } from "@/services/media-lease.service";
import { RETENTION_APPLY_ENABLED } from "@/services/media-retention-config";

/**
 * Fases 19.8a/19.8b-2 — retención de MediaAsset y MediaReconcileRun.
 * - DRY_RUN (por defecto; el ÚNICO que usa hoy la aplicación): ejecuta las selecciones (WHERE, orden, LIMIT y
 *   `FOR UPDATE … SKIP LOCKED`) y devuelve recuentos. No elimina ni modifica filas de
 *   MediaAsset ni de MediaReconcileRun; sí renueva el lease en cada lote (fila del lock y heartbeat de la ejecución en curso).
 * - APPLY (solo si quien llama pasa `mode: "APPLY"` Y RETENTION_APPLY_ENABLED es true: segunda barrera, en este servicio,
 *   con la MISMA constante que usa resolveRetentionMode; mientras sea false, `mode: "APPLY"` se degrada a DRY_RUN antes de
 *   ejecutar ninguna sentencia, sea quien sea el llamador): cada lote es UNA sentencia
 *   `WITH v AS MATERIALIZED (<la misma selección> FOR UPDATE … SKIP LOCKED) DELETE … USING v RETURNING …`, dentro de la
 *   misma transacción withLease que comprueba y renueva el lease. Sin cursor: como las filas desaparecen, cada lote vuelve
 *   a seleccionar desde el principio, y una fila saltada por estar bloqueada se reconsidera en el lote siguiente. Orden:
 *   primero MediaAsset y después ejecuciones (los NOT EXISTS de las ejecuciones se evalúan en cada lote: ven los borrados
 *   ya confirmados). Los recuentos de borrado salen de RETURNING y solo se suman tras el COMMIT.
 *
 * Cada lote va en una transacción withLease (fila del lock bloqueada → token, dueño y vigencia comprobados con el reloj
 * de PostgreSQL, ejecución RUNNING → renovación del lease) y se CONFIRMA: la renovación es persistente, nunca se simula
 * nada con un rollback. Orden de bloqueo: lock → filas (MediaAsset por (delivery, publicId); ejecuciones por token).
 * `SKIP LOCKED`: nunca espera por filas que otro tiene bloqueadas (p. ej. el borrado de una cuenta) → sin interbloqueos
 * por su parte; esas filas se cuentan en la siguiente ejecución (los recuentos son una cota inferior).
 *
 * Política CLEARED (19.9c, decisión I-1): la antigüedad de TODA fila de MediaAsset se mide desde `lastCandidateAt` (la última
 * observación como candidata), también en CLEARED: no existe `clearedAt` y la transición a CLEARED no toca las fechas. Es
 * decir, «CLEARED 30 días» = 30 días desde la última observación, no desde que se limpió (con ejecuciones irregulares una
 * fila puede ser elegible nada más limpiarse). Aceptado: solo se borra seguimiento, nunca medios.
 *
 * Límites por lote: lock_timeout 2 s (withLease), statement_timeout 5 s (local a la transacción), maxWait 2 s y timeout
 * 8 s de Prisma → cota BATCH_MAX_MS = 2 + 8 + 2 s de holgura (COMMIT/ROLLBACK) = 12 s. Supuesto (como en M1): ninguna
 * sentencia supera el timeout de la transacción salvo por esperas, que acotan lock_timeout y statement_timeout.
 * Un lote solo empieza si cabe entero en el presupuesto recibido. Máximo 10 lotes de 200 filas por fase.
 *
 * Cualquier error de un lote (40P01, 55P03, 57014, 23503/23001, P2028 u otro) detiene la retención SIN reintentar; el lote se
 * deshace entero (también su renovación). LEASE_LOST la detiene y se informa a quien llama (que detiene la ejecución).
 * Límite de DRY_RUN: las ejecuciones que quedarían libres al borrar MediaAsset no se cuentan (no se borra nada).
 */

export type RetentionMode = "DRY_RUN" | "APPLY";
/** Modo por defecto (y el que usa la aplicación). Cualquier valor distinto de "APPLY" exacto se trata como DRY_RUN. */
export const RETENTION_MODE: RetentionMode = "DRY_RUN";
export const RETENTION_BATCH_SIZE = 200;
export const RETENTION_MAX_BATCHES = 10;
export const RETENTION_LOCK_TIMEOUT_MS = 2_000;
export const RETENTION_STATEMENT_TIMEOUT_MS = 5_000;
export const RETENTION_TX_MAX_WAIT_MS = 2_000;
export const RETENTION_TX_TIMEOUT_MS = 8_000;
export const RETENTION_TX_SLACK_MS = 2_000;
export const RETENTION_BATCH_MAX_MS = RETENTION_TX_MAX_WAIT_MS + RETENTION_TX_TIMEOUT_MS + RETENTION_TX_SLACK_MS;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Políticas aprobadas (fase 19.2, decisiones C1–C6 de la 19.8). */
export const ASSET_RULES_MS = {
  CLEARED: 30 * DAY_MS,
  CLEARED_OWNER_MISSING: 7 * DAY_MS, // sujeta al suelo (C1): con graceHours = 24 → 14 días efectivos
  ACTIVE_OWNER_MISSING: 30 * DAY_MS, // CANDIDATE/CONFIRMED
  ACTIVE: 180 * DAY_MS,
} as const;
export const ASSET_FLOOR_MIN_MS = 14 * DAY_MS;
export const ASSET_FLOOR_GRACE_FACTOR = 7;
export const RUN_RULES_MS = { COMPLETED: 90 * DAY_MS, OTHER_TERMINAL: 30 * DAY_MS } as const; // sin suelo (C5)
export const RUN_KEEP_PER_STATUS = 14;
/** Allowlists explícitas: un estado nuevo o desconocido NUNCA es eliminable. */
export const DELETABLE_ASSET_STATES = ["CLEARED", "CANDIDATE", "CONFIRMED"] as const;
export const DELETABLE_RUN_STATUSES = ["COMPLETED", "INCOMPLETE", "FAILED", "ABANDONED"] as const;

export type AssetRule = keyof typeof ASSET_RULES_MS;

/** Suelo de MediaAsset (C1, C4): max(14 días, 7 × max(GRACE_HOURS actual, graceHours de la última ejecución observadora)). */
export function assetFloorMs(currentGraceHours: number, lastRunGraceHours: number): number {
  return Math.max(ASSET_FLOOR_MIN_MS, ASSET_FLOOR_GRACE_FACTOR * Math.max(currentGraceHours, lastRunGraceHours) * HOUR_MS);
}
/** Regla de una fila (null: estado fuera de la allowlist → nunca eliminable). */
export function assetRule(state: string, ownerMissing: boolean): AssetRule | null {
  if (state === "CLEARED") return ownerMissing ? "CLEARED_OWNER_MISSING" : "CLEARED";
  if (state === "CANDIDATE" || state === "CONFIRMED") return ownerMissing ? "ACTIVE_OWNER_MISSING" : "ACTIVE";
  return null;
}
/** Antigüedad mínima (por lastCandidateAt, nunca updatedAt) para que una fila sea eliminable; null → nunca. */
export function assetRetentionMs(state: string, ownerMissing: boolean, currentGraceHours: number, lastRunGraceHours: number): number | null {
  const rule = assetRule(state, ownerMissing);
  return rule === null ? null : Math.max(ASSET_RULES_MS[rule], assetFloorMs(currentGraceHours, lastRunGraceHours));
}
/** Antigüedad mínima (por finishedAt) de una ejecución terminal; null → nunca (RUNNING o desconocido). */
export function runRetentionMs(status: string): number | null {
  if (status === "COMPLETED") return RUN_RULES_MS.COMPLETED;
  if (status === "INCOMPLETE" || status === "FAILED" || status === "ABANDONED") return RUN_RULES_MS.OTHER_TERMINAL;
  return null;
}

type Tx = Prisma.TransactionClient;
const NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;
const ms = (v: number) => Prisma.sql`(${v}::float8 * interval '1 millisecond')`;

type AssetKey = { delivery: string; publicId: string };
type AssetRow = AssetKey & { rule: AssetRule };
type RunStatus = (typeof DELETABLE_RUN_STATUSES)[number];
type RunRow = { fencingToken: number; status: RunStatus };

/**
 * Lote de MediaAsset eliminables (la MISMA selección que usará APPLY), en orden (delivery, publicId COLLATE "C").
 * `after`: cursor de paginación (en DRY_RUN nada desaparece entre lotes).
 *
 * Estados desconocidos, DOS barreras independientes:
 *   1. allowlist explícita `a."state" IN ('CLEARED', 'CANDIDATE', 'CONFIRMED')` (valores del enum "MediaAssetState");
 *   2. `(regla) IS NOT NULL`: el CASE de la regla devuelve NULL fuera de la allowlist. OJO: GREATEST de PostgreSQL IGNORA
 *      los NULL (GREATEST(NULL, 14 días) = 14 días), así que sin esta barrera explícita el suelo sí se aplicaría.
 * Filtro previo indexable (índice (state, lastCandidateAt)): `lastCandidateAt < ahora − 14 días`. No excluye ninguna fila
 * elegible: el umbral efectivo de toda regla es GREATEST(regla, suelo) ≥ suelo ≥ 14 días. El instante «ahora» se calcula
 * UNA vez por sentencia (CTE): clock_timestamp() es volátil y no podría usarse como clave del índice; así, además, el
 * filtro previo y la regla usan exactamente el mismo instante.
 */
function assetSelection(graceHours: number, columns: Prisma.Sql, after: AssetKey | null) {
  const floor = Prisma.sql`GREATEST(${ms(ASSET_FLOOR_MIN_MS)}, ${ASSET_FLOOR_GRACE_FACTOR}::float8 * GREATEST(${graceHours}::float8, r."graceHours") * interval '1 hour')`;
  const ruleMs = Prisma.sql`CASE
      WHEN a."state" = 'CLEARED' AND NOT a."ownerMissing" THEN ${ms(ASSET_RULES_MS.CLEARED)}
      WHEN a."state" = 'CLEARED' AND a."ownerMissing" THEN ${ms(ASSET_RULES_MS.CLEARED_OWNER_MISSING)}
      WHEN a."state" IN ('CANDIDATE', 'CONFIRMED') AND a."ownerMissing" THEN ${ms(ASSET_RULES_MS.ACTIVE_OWNER_MISSING)}
      WHEN a."state" IN ('CANDIDATE', 'CONFIRMED') THEN ${ms(ASSET_RULES_MS.ACTIVE)} END`;
  const cursor = after
    ? Prisma.sql`AND (a."delivery", a."publicId" COLLATE "C") > (${after.delivery}::"MediaDelivery", ${after.publicId}::text COLLATE "C")`
    : Prisma.empty;
  const states = Prisma.join(DELETABLE_ASSET_STATES.map((st) => Prisma.sql`${st}::"MediaAssetState"`));
  const now = Prisma.sql`(SELECT "now" FROM t)`;
  return Prisma.sql`SELECT ${columns}
      FROM "MediaAsset" a JOIN "MediaReconcileRun" r ON r."id" = a."lastCandidateRunId"
     WHERE a."state" IN (${states})
       AND a."lastCandidateAt" < ${now} - ${ms(ASSET_FLOOR_MIN_MS)}
       AND (${ruleMs}) IS NOT NULL
       AND a."lastCandidateAt" < ${now} - GREATEST(${ruleMs}, ${floor})
       ${cursor}
     ORDER BY a."delivery", a."publicId" COLLATE "C"
     LIMIT ${RETENTION_BATCH_SIZE}
       FOR UPDATE OF a SKIP LOCKED`;
}
const ASSET_RULE = Prisma.sql`CASE
      WHEN a."state" = 'CLEARED' AND NOT a."ownerMissing" THEN 'CLEARED'
      WHEN a."state" = 'CLEARED' AND a."ownerMissing" THEN 'CLEARED_OWNER_MISSING'
      WHEN a."state" IN ('CANDIDATE', 'CONFIRMED') AND a."ownerMissing" THEN 'ACTIVE_OWNER_MISSING'
      WHEN a."state" IN ('CANDIDATE', 'CONFIRMED') THEN 'ACTIVE' END`;
const ASSET_NOW = Prisma.sql`t AS (SELECT ${NOW} AS "now")`;

/** DRY_RUN: la selección, paginada con cursor (nada desaparece entre lotes). */
function selectAssets(tx: Tx, graceHours: number, after: AssetKey | null) {
  return tx.$queryRaw<AssetRow[]>`
    WITH ${ASSET_NOW}
    ${assetSelection(graceHours, Prisma.sql`a."delivery"::text AS "delivery", a."publicId", ${ASSET_RULE} AS "rule"`, after)}`;
}
/**
 * APPLY: la MISMA selección (sin cursor) bloquea y borra en UNA sentencia. MATERIALIZED garantiza que la selección (con
 * su bloqueo SKIP LOCKED y su LIMIT) se evalúa una sola vez y antes del DELETE; el DELETE solo toca las filas que esa
 * selección bloqueó. Devuelve la regla de cada fila borrada (el orden de RETURNING no importa: no hay cursor).
 */
function deleteAssets(tx: Tx, graceHours: number) {
  return tx.$queryRaw<{ rule: AssetRule }[]>`
    WITH ${ASSET_NOW},
    v AS MATERIALIZED (
    ${assetSelection(graceHours, Prisma.sql`a."id", ${ASSET_RULE} AS "rule"`, null)})
    DELETE FROM "MediaAsset" d USING v WHERE d."id" = v."id"
    RETURNING v."rule" AS "rule"`;
}

/**
 * Lote de ejecuciones eliminables (la MISMA selección que usará APPLY), en orden de token. Nunca: RUNNING ni estados
 * desconocidos (allowlist), la dueña del lock, la de token máximo, las 14 más recientes (por token) de cada estado, ni
 * las referenciadas por MediaAsset. La fila del lock solo se LEE.
 */
function runSelectionParts(columns: Prisma.Sql, afterToken: number) {
  const retention = Prisma.sql`CASE r."status"::text
      WHEN 'COMPLETED' THEN ${ms(RUN_RULES_MS.COMPLETED)}
      WHEN 'INCOMPLETE' THEN ${ms(RUN_RULES_MS.OTHER_TERMINAL)}
      WHEN 'FAILED' THEN ${ms(RUN_RULES_MS.OTHER_TERMINAL)}
      WHEN 'ABANDONED' THEN ${ms(RUN_RULES_MS.OTHER_TERMINAL)} END`;
  const statuses = Prisma.join([...DELETABLE_RUN_STATUSES]);
  const ctes = Prisma.sql`mx AS (SELECT max("fencingToken") AS m FROM "MediaReconcileRun"),
         holder AS (SELECT "holderRunId" AS h FROM "MediaReconcileLock" WHERE "name" = 'media-reconcile'),
         ranked AS (
           SELECT "id", row_number() OVER (PARTITION BY "status" ORDER BY "fencingToken" DESC) AS rn
             FROM "MediaReconcileRun" WHERE "status"::text IN (${statuses}))`;
  const selection = Prisma.sql`SELECT ${columns}
      FROM "MediaReconcileRun" r JOIN ranked k ON k."id" = r."id" CROSS JOIN mx
     WHERE r."status"::text IN (${statuses})
       AND k.rn > ${RUN_KEEP_PER_STATUS}
       AND r."finishedAt" IS NOT NULL
       AND r."finishedAt" < ${NOW} - ${retention}
       AND r."fencingToken" < mx.m
       AND r."id" IS DISTINCT FROM (SELECT h FROM holder)
       AND NOT EXISTS (SELECT 1 FROM "MediaAsset" a WHERE a."firstCandidateRunId" = r."id")
       AND NOT EXISTS (SELECT 1 FROM "MediaAsset" a WHERE a."lastCandidateRunId" = r."id")
       AND r."fencingToken" > ${afterToken}
     ORDER BY r."fencingToken"
     LIMIT ${RETENTION_BATCH_SIZE}
       FOR UPDATE OF r SKIP LOCKED`;
  return { ctes, selection };
}
/** DRY_RUN: la selección, paginada por token. */
function selectRuns(tx: Tx, afterToken: number) {
  const { ctes, selection } = runSelectionParts(Prisma.sql`r."fencingToken", r."status"::text AS "status"`, afterToken);
  return tx.$queryRaw<RunRow[]>`
    WITH ${ctes}
    ${selection}`;
}
/**
 * APPLY: la MISMA selección (sin cursor: afterToken 0, que no excluye nada porque los tokens son > 0) bloquea y borra
 * en UNA sentencia. Las claves foráneas ON DELETE RESTRICT siguen mandando: una referencia que se colara haría fallar la
 * sentencia (23503) y la transacción entera se desharía.
 */
function deleteRuns(tx: Tx) {
  const { ctes, selection } = runSelectionParts(Prisma.sql`r."id", r."status"::text AS "status"`, 0);
  return tx.$queryRaw<{ status: RunStatus }[]>`
    WITH ${ctes},
    v AS MATERIALIZED (
    ${selection})
    DELETE FROM "MediaReconcileRun" d USING v WHERE d."id" = v."id"
    RETURNING v."status" AS "status"`;
}

export type RetentionStatus = "DONE" | "PARTIAL" | "SKIPPED" | "STOPPED" | "LEASE_LOST";
/** Por qué terminó una fase: COMPLETE (último lote incompleto) o lo que la cortó; NOT_STARTED si no llegó a empezar. */
export type RetentionPhaseEnd = "COMPLETE" | "BUDGET" | "MAX_BATCHES" | "STOPPED" | "LEASE_LOST" | "NOT_STARTED";
/**
 * Recuentos de una fase. `eligible`: filas elegibles que la selección llegó a BLOQUEAR en lotes confirmados (en APPLY,
 * las mismas que `deleted`). `deleted`: filas borradas y CONFIRMADAS (RETURNING, sumado tras el COMMIT; 0 en DRY_RUN).
 * Un lote fallido no suma nada. Nunca son totales exhaustivos: SKIP LOCKED salta las filas bloqueadas por otras
 * sesiones, y si la fase no terminó (`end` ≠ COMPLETE) quedaron filas sin inspeccionar.
 */
export interface RetentionPhase { eligible: number; deleted: number; batches: number; complete: boolean; end: RetentionPhaseEnd }
/** Resultado AGREGADO (sin identificadores): es lo que se guarda en el summary de la ejecución. */
export interface RetentionResult {
  mode: RetentionMode;
  status: RetentionStatus;
  /** Siempre true: los recuentos son una cota inferior (SKIP LOCKED y fases sin terminar). */
  countsAreLowerBound: true;
  assets: RetentionPhase & { byRule: Record<AssetRule, number>; deletedByRule: Record<AssetRule, number> };
  runs: RetentionPhase & { byStatus: Record<RunStatus, number>; deletedByStatus: Record<RunStatus, number> };
  errorCodes: string[];
}

/** SQLSTATE del adaptador (forma de Prisma 7: meta.driverAdapterError.cause.{originalCode|code}). */
function sqlState(e: unknown): string | null {
  const cause = (e as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } } } | null)?.meta?.driverAdapterError?.cause;
  const v = cause?.originalCode ?? cause?.code;
  return typeof v === "string" ? v : null;
}
/** Error de un lote → código genérico (nunca el mensaje). */
export function classifyRetentionError(e: unknown): string {
  if (e instanceof MediaLeaseError) return `retention/${e.code === "LOCK_TIMEOUT" ? "LOCK_TIMEOUT" : "LEASE_ERROR"}`;
  const state = sqlState(e);
  if (state === "40P01") return "retention/DEADLOCK";
  if (state === "55P03") return "retention/LOCK_TIMEOUT";
  if (state === "57014") return "retention/QUERY_TIMEOUT";
  // 23503 = foreign_key_violation (NO ACTION; en PostgreSQL 17 también RESTRICT). Desde PostgreSQL 18 una violación de ON DELETE RESTRICT
  // (el tipo de las FK de MediaAsset → MediaReconcileRun) es 23001 = restrict_violation; sin él, en producción (18.7) saldría DB_ERROR.
  if (state === "23503" || state === "23001") return "retention/FK_VIOLATION";
  if ((e as { code?: unknown } | null)?.code === "P2028") return "retention/TX_TIMEOUT";
  if (isDbError(e)) return "retention/DB_ERROR";
  return "retention/INTERNAL";
}

export interface RetentionOptions {
  /** Presupuesto (ms) desde que empieza; un lote solo empieza si cabe entero (RETENTION_BATCH_MAX_MS). */
  budgetMs: number;
  /** TTL con el que se renueva el lease en cada lote. */
  ttlMs: number;
  /** GRACE_HOURS actual (suelo de MediaAsset, C4). */
  graceHours: number;
  /** Reloj LOCAL solo para el presupuesto. */
  clock?: () => number;
  /** DRY_RUN por defecto; solo "APPLY" exacto borra, y solo si RETENTION_APPLY_ENABLED es true (si no, se ejecuta DRY_RUN). */
  mode?: RetentionMode;
}

const zeroRules = (): Record<AssetRule, number> => ({ CLEARED: 0, CLEARED_OWNER_MISSING: 0, ACTIVE_OWNER_MISSING: 0, ACTIVE: 0 });
const zeroStatuses = (): Record<RunStatus, number> => ({ COMPLETED: 0, INCOMPLETE: 0, FAILED: 0, ABANDONED: 0 });
/** Resultado vacío (sin lotes). */
export function emptyRetentionResult(status: RetentionStatus, errorCodes: string[] = [], mode: RetentionMode = RETENTION_MODE): RetentionResult {
  const phase = { eligible: 0, deleted: 0, batches: 0, complete: false, end: "NOT_STARTED" as RetentionPhaseEnd };
  return {
    mode, status, countsAreLowerBound: true,
    assets: { ...phase, byRule: zeroRules(), deletedByRule: zeroRules() },
    runs: { ...phase, byStatus: zeroStatuses(), deletedByStatus: zeroStatuses() },
    errorCodes,
  };
}

export function createMediaRetention(deps: { lease: Pick<MediaLeaseService, "withLease"> }) {
  return {
    async run(lease: MediaLease, opts: RetentionOptions): Promise<RetentionResult> {
      // Fail-closed, ANTES de cualquier consulta: solo "APPLY" exacto Y la constante de activación (la del resolutor) en true.
      // Cualquier otro valor, o la constante en false, → DRY_RUN; `mode` es el modo EFECTIVO y es el que se informa.
      const mode: RetentionMode = opts.mode === "APPLY" && RETENTION_APPLY_ENABLED === true ? "APPLY" : "DRY_RUN";
      const clock = opts.clock ?? (() => Date.now());
      const t0 = clock();
      const result = emptyRetentionResult("DONE", [], mode);
      const fits = () => clock() - t0 + RETENTION_BATCH_MAX_MS <= opts.budgetMs;
      if (!fits()) return emptyRetentionResult("SKIPPED", [], mode);
      const txOpts = {
        ttlMs: opts.ttlMs, lockTimeoutMs: RETENTION_LOCK_TIMEOUT_MS, maxWaitMs: RETENTION_TX_MAX_WAIT_MS, timeoutMs: RETENTION_TX_TIMEOUT_MS,
      };
      /**
       * Un lote protegido: statement_timeout local y la operación. Devuelve las filas SOLO si la transacción se confirmó
       * (withLease resuelve tras el COMMIT); "STOP" si hay que detenerse (el lote se deshizo entero, sin reintentos).
       */
      const batch = async <R>(phase: RetentionPhase, op: (tx: Tx) => Promise<R[]>): Promise<R[] | "STOP"> => {
        try {
          const r = await deps.lease.withLease(lease, async (tx) => {
            await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${RETENTION_STATEMENT_TIMEOUT_MS}ms`}, true)`;
            return op(tx);
          }, txOpts);
          if (r.ok) return r.value;
          if (r.reason === "LEASE_LOST") { result.status = "LEASE_LOST"; phase.end = "LEASE_LOST"; result.errorCodes.push("retention/LEASE_LOST"); }
          else { result.status = "STOPPED"; phase.end = "STOPPED"; result.errorCodes.push("retention/LOCK_TIMEOUT"); }
        } catch (e) {
          const code = classifyRetentionError(e);
          result.status = "STOPPED"; phase.end = "STOPPED"; result.errorCodes.push(code);
          // Una violación de clave foránea es la protección por referencia actuando: nunca se oculta.
          if (mode === "APPLY" || code === "retention/FK_VIOLATION") logError("media.retention", new Error(`Retención ${mode} detenida: ${code}`));
        }
        return "STOP";
      };
      /** Corte de una fase por presupuesto o por el máximo de lotes. */
      const cut = (phase: RetentionPhase): boolean => {
        if (phase.batches >= RETENTION_MAX_BATCHES) { phase.end = "MAX_BATCHES"; result.status = "PARTIAL"; return true; }
        if (!fits()) { phase.end = "BUDGET"; result.status = "PARTIAL"; return true; }
        return false;
      };

      // ── Fase 1: MediaAsset ─────────────────────────────────────────────────────────────────────────────────────
      const assets = result.assets;
      let after: AssetKey | null = null; // solo DRY_RUN
      while (!cut(assets)) {
        if (mode === "APPLY") {
          const rows = await batch(assets, (tx) => deleteAssets(tx, opts.graceHours));
          if (rows === "STOP") return result;
          assets.batches++;
          for (const r of rows) { assets.eligible++; assets.deleted++; assets.byRule[r.rule]++; assets.deletedByRule[r.rule]++; }
          if (rows.length < RETENTION_BATCH_SIZE) { assets.complete = true; assets.end = "COMPLETE"; break; }
        } else {
          const rows = await batch(assets, (tx) => selectAssets(tx, opts.graceHours, after));
          if (rows === "STOP") return result;
          assets.batches++;
          for (const r of rows) { assets.eligible++; assets.byRule[r.rule]++; }
          if (rows.length < RETENTION_BATCH_SIZE) { assets.complete = true; assets.end = "COMPLETE"; break; }
          after = { delivery: rows.at(-1)!.delivery, publicId: rows.at(-1)!.publicId };
        }
      }

      // ── Fase 2: MediaReconcileRun (después: ve los borrados ya confirmados de la fase 1) ─────────────────────────
      const runs = result.runs;
      let afterToken = 0; // solo DRY_RUN
      while (!cut(runs)) {
        if (mode === "APPLY") {
          const rows = await batch(runs, (tx) => deleteRuns(tx));
          if (rows === "STOP") return result;
          runs.batches++;
          for (const r of rows) { runs.eligible++; runs.deleted++; runs.byStatus[r.status]++; runs.deletedByStatus[r.status]++; }
          if (rows.length < RETENTION_BATCH_SIZE) { runs.complete = true; runs.end = "COMPLETE"; break; }
        } else {
          const rows = await batch(runs, (tx) => selectRuns(tx, afterToken));
          if (rows === "STOP") return result;
          runs.batches++;
          for (const r of rows) { runs.eligible++; runs.byStatus[r.status]++; }
          if (rows.length < RETENTION_BATCH_SIZE) { runs.complete = true; runs.end = "COMPLETE"; break; }
          afterToken = Number(rows.at(-1)!.fencingToken);
        }
      }
      return result;
    },
  };
}

export type MediaRetention = ReturnType<typeof createMediaRetention>;
