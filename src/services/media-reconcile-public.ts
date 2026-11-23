import { parseUtcTimestamp, type MediaReconcileReport } from "@/services/media-reconcile.service";
import { PUBLIC_RETENTION_ERROR_CODES } from "@/services/media-retention-public";

/**
 * Fase 19.9d — frontera PÚBLICA de los códigos de error generales de /api/cron/media-reconcile/run.
 * Se aplica SOLO al construir la respuesta HTTP (nunca al generar los errores): los códigos originales siguen intactos en
 * los logs, en MediaReconcileRun.errorCodes y en el summary persistido. Nada de lo que no esté aquí sale al cliente:
 *   - códigos exactos de una lista blanca (inventario real del código fuente);
 *   - dos familias acotadas: `db/P` + 4 dígitos ASCII y `CLOUDINARY_` + código HTTP de 3 dígitos (100–599).
 * Todo lo demás (desconocido, malformado, no texto) se sustituye por `internal/UNKNOWN_CODE`.
 * `retention.errorCodes` NO pasa por aquí: conserva su propia lista (media-retention-public.ts).
 */
export const UNKNOWN_PUBLIC_CODE = "internal/UNKNOWN_CODE";
export const MAX_PUBLIC_ERROR_CODES = 64;
/** Marcador que añade normalizeErrorCodes cuando había más de 64 códigos únicos. */
const TRUNCATED = "TRUNCATED";

/** Códigos de MediaAssetError (persist/*), MediaLeaseError (lease/*) y literales del orquestador. */
const STATIC_CODES: ReadonlySet<string> = new Set([
  TRUNCATED, "budget/TIME_EXHAUSTED", "detect/INTERNAL", "detect/INCOMPLETE", "db/DB_ERROR",
  "persist/INVALID_ARGUMENT", "persist/INCOMPLETE_DETECTION", "persist/TOO_MANY_CANDIDATES", "persist/RUN_NOT_ACTIVE",
  "persist/STALE_RUN", "persist/CONCURRENT_MODIFICATION", "persist/INTERNAL",
  "lease/INVALID_ARGUMENT", "lease/LOCK_UNAVAILABLE", "lease/LOCK_TIMEOUT", "lease/TOKEN_EXHAUSTED", "lease/LEASE_LOST",
]);

/** Códigos finitos del detector, por etapa (lo que escriben fail(), la normalización del inventario y readOrNull). */
const INVENTORY_CODES: ReadonlySet<string> = new Set([
  "TIME_BUDGET", "PAGE_LIMIT", "MALFORMED_PAGE", "BAD_CURSOR", "MALFORMED_RESOURCE", "UNEXPECTED_RESOURCE", "CLOUDINARY_ERROR",
]);
const DATABASE_CODES: ReadonlySet<string> = new Set(["QUERY_TIMEOUT", "DB_ERROR"]);
const SCOPES: Readonly<Record<"inventory" | "database", ReadonlySet<string>>> = {
  inventory: new Set(["upload", "authenticated"]),
  database: new Set(["wardrobe", "personal", "try-on", "sourcePhoto", "owners", "urls"]),
};

/** Familias acotadas: `P` + 4 dígitos ASCII (Prisma) y `CLOUDINARY_` + HTTP 100–599. Sin sufijos, espacios, signos ni decimales. */
const PRISMA_CODE = /^P[0-9]{4}$/;
const CLOUDINARY_HTTP = /^CLOUDINARY_[1-5][0-9]{2}$/;

const isStage = (s: unknown): s is "inventory" | "database" => s === "inventory" || s === "database";

/** ¿Es `code` (el último segmento) válido para esa etapa? */
function detectorCodeAllowed(stage: "inventory" | "database", code: string): boolean {
  if (stage === "inventory") return INVENTORY_CODES.has(code) || CLOUDINARY_HTTP.test(code);
  return DATABASE_CODES.has(code) || PRISMA_CODE.test(code);
}

/** Código público completo: lista exacta, `db/P####` o `etapa/ámbito/código` del detector. */
export function isPublicErrorCode(c: unknown): c is string {
  if (typeof c !== "string") return false;
  if (STATIC_CODES.has(c) || PUBLIC_RETENTION_ERROR_CODES.has(c)) return true;
  if (c.startsWith("db/")) return PRISMA_CODE.test(c.slice(3));
  const parts = c.split("/");
  if (parts.length !== 3 || !isStage(parts[0])) return false;
  return SCOPES[parts[0]].has(parts[1]!) && detectorCodeAllowed(parts[0], parts[2]!);
}

/** `errorCodes` generales para la respuesta: autorizados o `internal/UNKNOWN_CODE`; únicos, en orden estable, máximo 64. */
export function publicErrorCodes(codes: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(codes) ? codes : []) {
    const v = isPublicErrorCode(c) ? c : UNKNOWN_PUBLIC_CODE;
    if (seen.has(v)) continue;
    seen.add(v); out.push(v);
  }
  if (out.length <= MAX_PUBLIC_ERROR_CODES) return out;
  return [...out.filter((c) => c !== TRUNCATED).slice(0, MAX_PUBLIC_ERROR_CODES - 1), TRUNCATED];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
/** Contadores y medidas: solo números finitos (cualquier otra cosa → 0, nunca se copia tal cual). */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
/**
 * Fechas (19.9d.3): solo ISO 8601 UTC con `Z` y REAL, validadas con parseUtcTimestamp (el mismo validador estricto del
 * detector: rechaza texto arbitrario, fechas imposibles, sin zona o con offset). Si es válida se conserva la cadena EXACTA
 * (lo que genera Date.toISOString() sale idéntico); si no, valor neutro.
 */
const isoOrEmpty = (v: unknown): string => (typeof v === "string" && parseUtcTimestamp(v) !== null ? v : "");
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && parseUtcTimestamp(v) !== null ? v : null);

/**
 * Informe del detector para la respuesta (19.9d.2): PROYECCIÓN EXPLÍCITA, sin spread del informe ni de sus objetos
 * anidados. Solo salen los campos agregados enumerados aquí (mismos nombres y estructura que el contrato HTTP); cualquier
 * propiedad adicional, en el informe o en un objeto anidado, se descarta. Los valores se copian solo si son del tipo
 * esperado (números finitos, booleanos, texto). `errors[].code` pasa por la lista blanca; `stage`/`scope` solo se aceptan
 * si son los valores fijos del detector. No modifica el informe original.
 */
export function publicReport(report: MediaReconcileReport | null | undefined): MediaReconcileReport | null {
  if (!report || typeof report !== "object") return null;
  const r = report as unknown as Obj;
  const raw = r.errors;
  const errors = (Array.isArray(raw) ? raw : []).map((e: unknown) => {
    const o = obj(e);
    const scopeOk = isStage(o.stage) && typeof o.scope === "string" && SCOPES[o.stage].has(o.scope);
    const stage = isStage(o.stage) ? o.stage : ("inventory" as const);
    const codeOk = scopeOk && typeof o.code === "string" && detectorCodeAllowed(stage, o.code);
    return { stage, scope: scopeOk ? (o.scope as string) : "UNKNOWN", code: codeOk ? (o.code as string) : UNKNOWN_PUBLIC_CODE };
  });
  const inventoryComplete = obj(r.inventoryComplete); const pages = obj(r.pages); const byKind = obj(r.byKind);
  const byCategory = obj(r.byCategory); const orphanDetail = obj(r.orphanDetail); const protection = obj(r.protection);
  const quarantine = obj(r.quarantine); const metadata = obj(r.metadata); const broken = obj(r.brokenReferences);
  const urlRaw = r.urlReferences; const rateRaw = r.rateLimit;
  const url = obj(urlRaw); const rate = obj(rateRaw);
  return {
    startedAt: isoOrEmpty(r.startedAt),
    durationMs: num(r.durationMs),
    complete: bool(r.complete),
    inventoryStatus: r.inventoryStatus === "COMPLETE" ? "COMPLETE" : "INCOMPLETE",
    inventoryComplete: { upload: bool(inventoryComplete.upload), authenticated: bool(inventoryComplete.authenticated) },
    graceHours: num(r.graceHours),
    pages: { upload: num(pages.upload), authenticated: num(pages.authenticated) },
    resourcesExamined: num(r.resourcesExamined),
    byKind: { wardrobe: num(byKind.wardrobe), personal: num(byKind.personal), tryOn: num(byKind.tryOn), unknown: num(byKind.unknown), quarantine: num(byKind.quarantine) },
    byCategory: {
      REFERENCED: num(byCategory.REFERENCED), ORPHAN_CANDIDATE: num(byCategory.ORPHAN_CANDIDATE), TOO_RECENT: num(byCategory.TOO_RECENT),
      UNKNOWN: num(byCategory.UNKNOWN), INCOMPLETE: num(byCategory.INCOMPLETE), QUARANTINED: num(byCategory.QUARANTINED),
    },
    candidatesWithheld: num(r.candidatesWithheld),
    orphanDetail: { ownerMissing: num(orphanDetail.ownerMissing), personalCitedOnlyBySourcePhoto: num(orphanDetail.personalCitedOnlyBySourcePhoto) },
    protection: { referencedByUrlOnly: num(protection.referencedByUrlOnly), ambiguousUrl: num(protection.ambiguousUrl), missingMetadata: num(protection.missingMetadata) },
    quarantine: { wardrobe: num(quarantine.wardrobe), personal: num(quarantine.personal), tryOn: num(quarantine.tryOn), publicDelivery: num(quarantine.publicDelivery) },
    metadata: { assetId: num(metadata.assetId), version: num(metadata.version), createdAt: num(metadata.createdAt), bytes: num(metadata.bytes), format: num(metadata.format) },
    urlReferences: urlRaw && typeof urlRaw === "object"
      ? { scanned: num(url.scanned), own: num(url.own), ownOutsidePrefix: num(url.ownOutsidePrefix), external: num(url.external), ambiguous: num(url.ambiguous) }
      : null,
    brokenReferences: { total: numOrNull(broken.total), wardrobe: numOrNull(broken.wardrobe), personal: numOrNull(broken.personal), tryOn: numOrNull(broken.tryOn) },
    referencesOutsidePrefix: numOrNull(r.referencesOutsidePrefix),
    rateLimit: rateRaw && typeof rateRaw === "object" ? { allowed: numOrNull(rate.allowed), remaining: numOrNull(rate.remaining), resetAt: isoOrNull(rate.resetAt) } : null,
    errors,
  };
}
