/**
 * Fase 19.8b-1 — resolutor del modo de retención (DRY_RUN / APPLY). Función PURA: recibe el entorno como argumento (el
 * llamador pasa process.env) y nunca lanza. No forma parte del esquema Zod global: una configuración inválida aquí no
 * puede impedir que arranque la aplicación; simplemente deja la retención en DRY_RUN.
 *
 * APPLY solo si se cumplen A LA VEZ, con igualdad EXACTA (sin trim, sin mayúsculas/minúsculas, sin conversiones):
 *   1. `enabled === true` (en la aplicación: la constante RETENTION_APPLY_ENABLED, que permanece en false);
 *   2. MEDIA_RETENTION_MODE === "APPLY";
 *   3. MEDIA_RETENTION_APPLY_CONFIRM === RETENTION_APPLY_CONFIRMATION (frase fija de la versión de la política);
 *   4. VERCEL_ENV === "production" (entorno autorizado; en local no existe).
 * Cualquier otra combinación → DRY_RUN. El resultado solo lleva códigos genéricos: nunca valores del entorno.
 * Todavía no lo usa ningún servicio (la integración y el borrado son subfases posteriores).
 */

/** Constante de producción: APPLY desactivado. Cambiarla requiere una subfase de activación aprobada expresamente. */
export const RETENTION_APPLY_ENABLED: boolean = false;
/** Frase de confirmación (no es un secreto): identifica la versión de la política de retención que se autoriza. */
export const RETENTION_APPLY_CONFIRMATION = "apply-media-retention-policy-v1";
export const RETENTION_APPLY_ENVIRONMENT = "production";
export const RETENTION_ENV_VARS = {
  mode: "MEDIA_RETENTION_MODE",
  confirm: "MEDIA_RETENTION_APPLY_CONFIRM",
  environment: "VERCEL_ENV",
} as const;

export type RetentionModeReason =
  /** Sin MEDIA_RETENTION_MODE: DRY_RUN por defecto (configuración válida). */
  | "MODE_NOT_SET"
  /** MEDIA_RETENTION_MODE === "DRY_RUN" exacto (configuración válida). */
  | "MODE_DRY_RUN"
  /** MEDIA_RETENTION_MODE con cualquier otro valor (vacío, espacios, minúsculas, desconocido, no texto). */
  | "MODE_INVALID"
  /** Confirmación presente sin MEDIA_RETENTION_MODE=APPLY: configuración parcial o sobrante. */
  | "CONFIRM_WITHOUT_APPLY"
  | "CONFIRM_MISSING"
  | "CONFIRM_INVALID"
  | "ENVIRONMENT_NOT_AUTHORIZED"
  /** Configuración completa y correcta, pero APPLY desactivado en el código. */
  | "APPLY_DISABLED_IN_CODE"
  /** El entorno recibido no se pudo leer. */
  | "ENV_UNAVAILABLE";

export type RetentionModeResolution =
  | { readonly mode: "APPLY"; readonly valid: true; readonly reason: null }
  | { readonly mode: "DRY_RUN"; readonly valid: boolean; readonly reason: RetentionModeReason };

type EnvLike = Readonly<Record<string, unknown>>;

const dryRun = (valid: boolean, reason: RetentionModeReason): RetentionModeResolution => Object.freeze({ mode: "DRY_RUN", valid, reason });

/**
 * Decide el modo efectivo. Orden: primero se valida la configuración (para detectar errores aunque APPLY esté
 * desactivado en el código) y, al final, la constante `enabled`. `valid` indica si la configuración es coherente; no
 * si se permite APPLY.
 */
export function resolveRetentionMode(env: unknown, enabled: unknown): RetentionModeResolution {
  let mode: unknown; let confirm: unknown; let environment: unknown;
  try {
    if (env === null || typeof env !== "object") return dryRun(false, "ENV_UNAVAILABLE");
    const e = env as EnvLike;
    mode = e[RETENTION_ENV_VARS.mode];
    confirm = e[RETENTION_ENV_VARS.confirm];
    environment = e[RETENTION_ENV_VARS.environment];
  } catch {
    return dryRun(false, "ENV_UNAVAILABLE");
  }

  if (mode === undefined) return confirm === undefined ? dryRun(true, "MODE_NOT_SET") : dryRun(false, "CONFIRM_WITHOUT_APPLY");
  if (mode === "DRY_RUN") return confirm === undefined ? dryRun(true, "MODE_DRY_RUN") : dryRun(false, "CONFIRM_WITHOUT_APPLY");
  if (mode !== "APPLY") return dryRun(false, "MODE_INVALID");
  if (confirm === undefined) return dryRun(false, "CONFIRM_MISSING");
  if (confirm !== RETENTION_APPLY_CONFIRMATION) return dryRun(false, "CONFIRM_INVALID");
  if (environment !== RETENTION_APPLY_ENVIRONMENT) return dryRun(false, "ENVIRONMENT_NOT_AUTHORIZED");
  if (enabled !== true) return dryRun(true, "APPLY_DISABLED_IN_CODE");
  return Object.freeze({ mode: "APPLY", valid: true, reason: null });
}
