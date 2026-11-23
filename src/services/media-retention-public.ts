import type { RetentionResult } from "@/services/media-retention.service";

/**
 * Códigos de retención AUTORIZADOS para la respuesta HTTP: exactamente los que producen classifyRetentionError, el lote
 * (LEASE_LOST / LOCK_TIMEOUT) y el orquestador (retention/INTERNAL). Comparación por igualdad exacta con esta lista:
 * nada que no esté aquí sale jamás, sea cual sea su forma.
 */
export const PUBLIC_RETENTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "retention/LOCK_TIMEOUT", "retention/LEASE_ERROR", "retention/LEASE_LOST", "retention/DEADLOCK", "retention/QUERY_TIMEOUT",
  "retention/FK_VIOLATION", "retention/TX_TIMEOUT", "retention/DB_ERROR", "retention/INTERNAL",
]);
/** Único sustituto de cualquier código no autorizado (aparece como máximo una vez). */
export const UNKNOWN_RETENTION_ERROR_CODE = "retention/UNKNOWN_CODE";

/** Lista blanca estricta: autorizados (sin duplicados, en orden de aparición) y, si hubo alguno ajeno, un único UNKNOWN. */
export function publicRetentionErrorCodes(codes: unknown): string[] {
  const out = new Set<string>();
  let unknown = false;
  for (const c of Array.isArray(codes) ? codes : []) {
    if (typeof c === "string" && PUBLIC_RETENTION_ERROR_CODES.has(c)) out.add(c);
    else unknown = true;
  }
  return unknown ? [...out, UNKNOWN_RETENTION_ERROR_CODE] : [...out];
}

/**
 * Fase 19.8c — vista PÚBLICA (respuesta HTTP) del resultado de retención. Lista blanca explícita: solo se copian los
 * campos agregados conocidos (nada de lo que traiga el objeto de más) y los errorCodes se filtran contra PUBLIC_RETENTION_ERROR_CODES (19.8c.1). Sin resultado
 * (retención no ejecutada) → null. No cambia el resumen persistido ni los recuentos.
 */
export function publicRetention(r: RetentionResult | null | undefined) {
  if (!r) return null;
  return {
    mode: r.mode,
    status: r.status,
    countsAreLowerBound: r.countsAreLowerBound,
    assets: {
      eligible: r.assets.eligible, deleted: r.assets.deleted, batches: r.assets.batches, complete: r.assets.complete, end: r.assets.end,
      byRule: {
        CLEARED: r.assets.byRule.CLEARED, CLEARED_OWNER_MISSING: r.assets.byRule.CLEARED_OWNER_MISSING,
        ACTIVE_OWNER_MISSING: r.assets.byRule.ACTIVE_OWNER_MISSING, ACTIVE: r.assets.byRule.ACTIVE,
      },
      deletedByRule: {
        CLEARED: r.assets.deletedByRule.CLEARED, CLEARED_OWNER_MISSING: r.assets.deletedByRule.CLEARED_OWNER_MISSING,
        ACTIVE_OWNER_MISSING: r.assets.deletedByRule.ACTIVE_OWNER_MISSING, ACTIVE: r.assets.deletedByRule.ACTIVE,
      },
    },
    runs: {
      eligible: r.runs.eligible, deleted: r.runs.deleted, batches: r.runs.batches, complete: r.runs.complete, end: r.runs.end,
      byStatus: {
        COMPLETED: r.runs.byStatus.COMPLETED, INCOMPLETE: r.runs.byStatus.INCOMPLETE, FAILED: r.runs.byStatus.FAILED, ABANDONED: r.runs.byStatus.ABANDONED,
      },
      deletedByStatus: {
        COMPLETED: r.runs.deletedByStatus.COMPLETED, INCOMPLETE: r.runs.deletedByStatus.INCOMPLETE,
        FAILED: r.runs.deletedByStatus.FAILED, ABANDONED: r.runs.deletedByStatus.ABANDONED,
      },
    },
    errorCodes: publicRetentionErrorCodes(r.errorCodes),
  };
}
