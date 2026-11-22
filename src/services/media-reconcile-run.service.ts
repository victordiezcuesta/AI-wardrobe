import type { Prisma } from "@/generated/prisma/client";
import { logError } from "@/lib/errors";
import { isDbError } from "@/lib/errors/db";
import { MAX_CANDIDATES, MediaAssetError, persistMediaCandidates, type PersistSummary } from "@/services/media-asset.service";
import { MediaLeaseError, mediaLeaseService, type AcquiredLease, type Finished, type MediaLeaseService, type RunOutcome } from "@/services/media-lease.service";
import {
  DEFAULT_GRACE_MS, detectOrphanMediaDetailed, type DetailedDetection, type MediaReconcileReport,
} from "@/services/media-reconcile.service";

/**
 * Fase 19.7 — orquestador de la reconciliación de medios: lease → detección detallada → persistencia atómica → cierre.
 * Solo coordina los tres servicios existentes (no repite ninguna de sus comprobaciones):
 *   1. acquire (TTL 360 s): BUSY → no se toca nada.
 *   2. Detección con `now` = startedAt de PostgreSQL devuelto por acquire (nunca Date.now()) y el mismo periodo de gracia
 *      que se guarda en la ejecución. Inventario + lecturas de PostgreSQL acotados a DETECT_BUDGET_MS (límite efectivo en
 *      PostgreSQL: statement_timeout por lectura).
 *   3. Detección incompleta → release INCOMPLETE. persistMediaCandidates NO se llama (MediaAsset intacto).
 *   4. Completa → finishWith + persistMediaCandidates en UNA transacción (observaciones, CLEARED, cierre COMPLETED y
 *      liberación del lock: todo o nada). Si falla, la transacción ya se ha deshecho y se cierra con release FAILED.
 * Sin renovación periódica: el TTL (360 s) supera maxDuration (300 s) en ≥ 60 s, y finishWith/persist validan el lease
 * con el reloj de PostgreSQL. No borra nada en Cloudinary. El resultado y los logs son AGREGADOS: nunca publicId, URLs,
 * ownerUserId, assetId, candidatas, runId ni fencingToken; los errores se reducen a códigos genéricos.
 * `Date.now()` solo se usa para el presupuesto local (decidir si queda tiempo para un reintento).
 */

/** Debe coincidir con `maxDuration` de la ruta /api/cron/media-reconcile/run (lo comprueban las pruebas). */
export const RUN_MAX_DURATION_MS = 300_000;
export const LEASE_TTL_MS = 360_000;
/** Margen mínimo entre la caducidad del lease y el final forzoso de la función. */
export const LEASE_MARGIN_MS = 60_000;
/** Inventario (150 s) + lecturas de PostgreSQL del detector (30 s): 180 s en total como máximo. */
export const INVENTORY_BUDGET_MS = 150_000;
export const QUERY_BUDGET_MS = 30_000;
export const DETECT_BUDGET_MS = INVENTORY_BUDGET_MS + QUERY_BUDGET_MS;
/** Inventario mínimo con sentido: con menos, no se empieza la detección (se cierra FAILED budget/TIME_EXHAUSTED). */
export const MIN_INVENTORY_BUDGET_MS = 10_000;
/** Periodo de gracia ÚNICO: el detector lo recibe en ms y acquire lo guarda en horas (lo usa la persistencia). */
export const GRACE_MS = DEFAULT_GRACE_MS;
export const GRACE_HOURS = GRACE_MS / 3_600_000;
export const LOCK_TIMEOUT_MS = 2_000;
/**
 * Presupuesto temporal (reloj LOCAL, solo para decidir si se empieza una operación; desde el inicio de run()).
 *
 * Cotas reales de cada operación del lease (acquire, finishWith, release): media-lease.service usa
 * TX = { maxWait: 10 s, timeout: 30 s } y lock_timeout (2 s) dentro de ese intervalo → 10 + 30 s, más 2 s de holgura para
 * el COMMIT/ROLLBACK final = LEASE_OP_MAX_MS (42 s). Supuesto: ninguna sentencia del lease o de la persistencia supera el
 * timeout de su transacción salvo por esperas de bloqueo, que ya acota lock_timeout.
 * Detección: inventario + lecturas ≤ su presupuesto (plazo absoluto) + DETECT_OVERRUN_MS (clasificación en memoria y
 * temporizadores que vencen justo en el plazo).
 *
 * Regla: una operación solo empieza si `transcurrido + su cota + lo que haya que reservar después ≤ HARD_DEADLINE_MS`
 * (300 s − 10 s de margen = 290 s). Peor caso del camino principal (cada paso agota su cota):
 *   acquire 42 → detección ≤ 290 − 42 − 2·42 − 5 = 159 (+5) → 206 → finishWith 42 → 248 → release 42 → 290 ≤ 290.
 * Con acquire normal (≈ 0 s) la detección recibe sus 180 s completos (290 − 2·42 − 5 = 201 ≥ 180) y el camino termina en
 * ≤ 0 + 185 + 42 + 42 = 269 s; los reintentos solo se hacen si su cota (y la del release que pueda seguirlos) cabe todavía.
 * Si una operación no cabe, no se empieza: la ejecución queda RUNNING (finalized false, budget/TIME_EXHAUSTED) y se
 * recupera sola al caducar el lease (la siguiente adquisición la marca ABANDONED).
 */
export const SAFETY_MARGIN_MS = 10_000;
export const HARD_DEADLINE_MS = RUN_MAX_DURATION_MS - SAFETY_MARGIN_MS;
/** Cotas de media-lease.service (TX), comprobadas en las pruebas. */
export const LEASE_TX_MAX_WAIT_MS = 10_000;
export const LEASE_TX_TIMEOUT_MS = 30_000;
export const LEASE_OP_SLACK_MS = 2_000;
export const LEASE_OP_MAX_MS = LEASE_TX_MAX_WAIT_MS + LEASE_TX_TIMEOUT_MS + LEASE_OP_SLACK_MS;
export const DETECT_OVERRUN_MS = 5_000;
export const TIME_EXHAUSTED = "budget/TIME_EXHAUSTED";
/** Restricciones de errorCodes en media-lease.service (checkCodes). */
export const MAX_ERROR_CODES = 64;
export const MAX_ERROR_CODE_LENGTH = 120;

export type RunOutcomeKind = "COMPLETED" | "INCOMPLETE" | "FAILED" | "LEASE_LOST";
export type MediaReconcileRunResult =
  | { outcome: "BUSY"; reason: "LEASE_HELD" | "LOCK_TIMEOUT" }
  | {
    outcome: RunOutcomeKind;
    /** La ejecución quedó cerrada (COMPLETED/INCOMPLETE/FAILED). false → sigue RUNNING hasta que caduque el lease. */
    finalized: boolean;
    /** Informe AGREGADO del detector (null si no llegó a producirse). */
    report: MediaReconcileReport | null;
    /** Recuentos de la persistencia (solo COMPLETED). */
    persisted: PersistSummary | null;
    errorCodes: string[];
  };

export interface RunnerDeps {
  lease: Pick<MediaLeaseService, "acquire" | "finishWith" | "release">;
  detect: (opts: { now: Date; graceMs: number; budgetMs: number; queryBudgetMs: number }) => Promise<DetailedDetection>;
  persist: typeof persistMediaCandidates;
  /** Reloj LOCAL solo para el presupuesto de reintentos (inyectable en pruebas). */
  clock?: () => number;
  codeVersion?: string | null;
}

const CODE_CHARS = /[^A-Za-z0-9_./:-]/g;
const TRUNCATED = "TRUNCATED";
/**
 * Códigos aptos para release/finishWith: texto saneado (sin espacios ni caracteres arbitrarios), 1..120 caracteres y sin
 * duplicados. Hasta 64 códigos únicos se conservan TODOS; solo si hay más de 64 se devuelven los 63 primeros y
 * "TRUNCATED" (nunca más de 64). Nunca lanza.
 */
export function normalizeErrorCodes(codes: readonly unknown[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(codes) ? codes : []) {
    if (typeof c !== "string") continue;
    const v = c.replace(CODE_CHARS, "_").slice(0, MAX_ERROR_CODE_LENGTH);
    if (!v || seen.has(v)) continue;
    seen.add(v); unique.push(v);
    if (unique.length > MAX_ERROR_CODES) break; // ya se sabe que hay recorte real
  }
  if (unique.length <= MAX_ERROR_CODES) return unique;
  // El indicador no puede aparecer dos veces aunque llegara como código.
  return [...unique.filter((c) => c !== TRUNCATED).slice(0, MAX_ERROR_CODES - 1), TRUNCATED];
}

/** Códigos del informe del detector (`etapa/ámbito/código`, ya genéricos). */
export function reportErrorCodes(report: MediaReconcileReport): string[] {
  const codes = normalizeErrorCodes((report.errors ?? []).map((e) => `${e.stage}/${e.scope}/${e.code}`));
  return codes.length ? codes : ["detect/INCOMPLETE"];
}

/** Cualquier error → un código genérico. Nunca el mensaje (Prisma puede repetir publicId o ids de usuario en él). */
export function classifyFailure(err: unknown, stage: "detect" | "persist"): string {
  if (err instanceof MediaAssetError) return `persist/${err.code}`;
  if (err instanceof MediaLeaseError) return `lease/${err.code}`;
  if (isDbError(err)) {
    const code = (err as { code?: unknown }).code;
    return `db/${typeof code === "string" && /^P\d{4}$/.test(code) ? code : "DB_ERROR"}`;
  }
  return `${stage}/INTERNAL`;
}

const summaryOf = (report: MediaReconcileReport | null) => (report ? { report } : {}) as unknown as Prisma.InputJsonValue;

export function createMediaReconcileRunner(deps: RunnerDeps) {
  const clock = deps.clock ?? (() => Date.now());

  return {
    async run(): Promise<MediaReconcileRunResult> {
      const t0 = clock();
      /** ¿Cabe una operación de `opMs` dejando `reserveMs` para lo que deba ir después, sin pasar de HARD_DEADLINE_MS? */
      const fits = (opMs: number, reserveMs = 0) => clock() - t0 + opMs + reserveMs <= HARD_DEADLINE_MS;

      // ── 1. Lease ────────────────────────────────────────────────────────────────────────────────────────────────
      const acquired = await deps.lease.acquire({ graceHours: GRACE_HOURS, ttlMs: LEASE_TTL_MS, lockTimeoutMs: LOCK_TIMEOUT_MS, codeVersion: deps.codeVersion ?? null });
      if (acquired.status === "BUSY") return { outcome: "BUSY", reason: acquired.reason };
      const lease: AcquiredLease = acquired.lease;
      const startedAt = lease.startedAt; // reloj de PostgreSQL: el único instante de referencia de esta ejecución

      /**
       * Cierre sin persistencia (INCOMPLETE/FAILED): como máximo un reintento acotado si release no lo consigue. Ningún
       * intento empieza si su cota no cabe antes de HARD_DEADLINE_MS (entonces se añade budget/TIME_EXHAUSTED).
       */
      const close = async (kind: RunOutcomeKind, outcome: RunOutcome, report: MediaReconcileReport | null): Promise<MediaReconcileRunResult> => {
        let codes = normalizeErrorCodes(outcome.errorCodes ?? []);
        const args: RunOutcome = { ...outcome, errorCodes: codes, summary: summaryOf(report) };
        let finalized = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!fits(LEASE_OP_MAX_MS)) { codes = normalizeErrorCodes([...codes, TIME_EXHAUSTED]); break; }
          try {
            const r = await deps.lease.release(lease, args, { lockTimeoutMs: LOCK_TIMEOUT_MS });
            if (r.released) { finalized = r.runFinalized; break; }
            if (r.reason === "LEASE_LOST") break; // otra ejecución tiene el lock: ya marcó esta como ABANDONED
          } catch { /* se reintenta una vez; nunca se propagan detalles */ }
        }
        logError("media.reconcile.run", new Error(`Ejecución ${kind}${finalized ? "" : " (sin cerrar)"}: ${codes.join(", ")}`));
        return { outcome: kind, finalized, report, persisted: null, errorCodes: codes };
      };

      // ── 2. Detección (inventario + lecturas acotados) ────────────────────────────────────────────────────────────
      // Se reserva el tiempo del cierre (finishWith + un release tras su posible fallo). Si acquire tardó, el inventario
      // se acorta; las lecturas conservan sus 30 s. Sin un inventario mínimo, no se empieza.
      const detectAvailable = HARD_DEADLINE_MS - (clock() - t0) - 2 * LEASE_OP_MAX_MS - DETECT_OVERRUN_MS;
      const inventoryMs = Math.min(INVENTORY_BUDGET_MS, Math.floor(detectAvailable - QUERY_BUDGET_MS));
      if (inventoryMs < MIN_INVENTORY_BUDGET_MS) {
        return close("FAILED", { status: "FAILED", inventoryComplete: false, errorCodes: [TIME_EXHAUSTED] }, null);
      }
      let detection: DetailedDetection;
      try {
        detection = await deps.detect({ now: startedAt, graceMs: GRACE_MS, budgetMs: inventoryMs, queryBudgetMs: QUERY_BUDGET_MS });
      } catch (err) {
        return close("FAILED", { status: "FAILED", inventoryComplete: false, errorCodes: [classifyFailure(err, "detect")] }, null);
      }
      const { report } = detection;

      // ── 3. Incompleta: nunca se persiste ─────────────────────────────────────────────────────────────────────────
      if (report.complete !== true) {
        return close("INCOMPLETE", { status: "INCOMPLETE", inventoryComplete: report.inventoryStatus === "COMPLETE", errorCodes: reportErrorCodes(report) }, report);
      }
      if (detection.candidates.length > MAX_CANDIDATES) {
        return close("FAILED", { status: "FAILED", inventoryComplete: true, errorCodes: ["persist/TOO_MANY_CANDIDATES"] }, report);
      }

      // ── 4. Persistencia + cierre COMPLETED atómicos ─────────────────────────────────────────────────────────────
      const persistIn = (tx: Prisma.TransactionClient) => deps.persist(tx, { runId: lease.runId, startedAt, detection });
      let lockTimeouts = 0;
      for (;;) {
        // finishWith solo empieza si, además, cabe el release que lo seguiría si falla.
        if (!fits(LEASE_OP_MAX_MS, LEASE_OP_MAX_MS)) {
          return close("FAILED", { status: "FAILED", inventoryComplete: true, errorCodes: [lockTimeouts ? "lease/LOCK_TIMEOUT" : TIME_EXHAUSTED] }, report);
        }
        let finished: Finished<PersistSummary>;
        try {
          finished = await deps.lease.finishWith(lease, { summary: summaryOf(report), errorCodes: [] }, persistIn, { lockTimeoutMs: LOCK_TIMEOUT_MS });
        } catch (err) {
          // La transacción de finishWith ya se deshizo entera (ni filas, ni cierre, ni liberación).
          return close("FAILED", { status: "FAILED", inventoryComplete: true, errorCodes: [classifyFailure(err, "persist")] }, report);
        }
        if (finished.ok) return { outcome: "COMPLETED", finalized: true, report, persisted: finished.value, errorCodes: [] };
        if (finished.reason === "LEASE_LOST") {
          return close("LEASE_LOST", { status: "FAILED", inventoryComplete: true, errorCodes: ["lease/LEASE_LOST"] }, report);
        }
        // LOCK_TIMEOUT esperando la fila del lock: no se ejecutó nada. Un único reintento (si cabe: lo comprueba el bucle).
        if (++lockTimeouts > 1) {
          return close("FAILED", { status: "FAILED", inventoryComplete: true, errorCodes: ["lease/LOCK_TIMEOUT"] }, report);
        }
      }
    },
  };
}

export type MediaReconcileRunner = ReturnType<typeof createMediaReconcileRunner>;

/** Instancia de la aplicación (servicios reales). */
export const mediaReconcileRunner: MediaReconcileRunner = createMediaReconcileRunner({
  lease: mediaLeaseService,
  detect: (opts) => detectOrphanMediaDetailed(opts),
  persist: persistMediaCandidates,
  codeVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 64) || null,
});
