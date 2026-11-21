import { APP_ROOT_PREFIX, listAppResourcesPage, type DeliveryType, type ResourcePage } from "@/lib/cloudinary";
import { logError } from "@/lib/errors";
import { safeDbError } from "@/lib/errors/db";
import { prisma } from "@/lib/prisma";

/**
 * Detector de imágenes huérfanas — ESTRICTAMENTE DE SOLO LECTURA.
 *
 * Recorre el inventario de Cloudinary bajo `ai-wardrobe/` (públicas y privadas, paginado) y lo compara con las tres
 * fuentes de verdad de PostgreSQL. No borra, mueve ni etiqueta nada en Cloudinary y no escribe en la base de datos.
 * Devuelve un informe AGREGADO (recuentos, sin publicId, userId ni URLs).
 *
 * Fuentes de verdad (referencias de almacenamiento):
 * - wardrobe  (público)  → WardrobeItem.imagePublicId (varias prendas pueden compartir imagen);
 * - personal  (privado)  → UserProfile.photoPublicIds;
 * - try-on    (privado)  → GeneratedImage.publicId.
 * `GeneratedImage.sourcePhotoId` es una cita histórica, NO una referencia de almacenamiento: solo se informa. Las URLs
 * (`imageUrl`, `thumbUrl`, `User.image`, catálogo, compras) no son referencias.
 */

export type MediaKind = "wardrobe" | "personal" | "try-on";
export type MediaCategory = "REFERENCED" | "ORPHAN_CANDIDATE" | "TOO_RECENT" | "UNKNOWN" | "INCOMPLETE";

/**
 * Página de la Admin API: se inyecta en las pruebas; por defecto, la función de solo lectura de la librería. Debe cancelar
 * la petición cuando se aborte `signal` (el detector, además, deja de esperarla en ese mismo instante).
 */
export type ListPage = (type: DeliveryType, cursor: string | undefined, signal: AbortSignal) => Promise<ResourcePage>;

export interface MediaReconcileReport {
  startedAt: string;
  durationMs: number;
  /** true solo si las dos paginaciones terminaron sin errores ni límites y todas las consultas a la base de datos fueron bien. */
  complete: boolean;
  inventoryComplete: { upload: boolean; authenticated: boolean };
  graceHours: number;
  pages: { upload: number; authenticated: number };
  resourcesExamined: number;
  byKind: { wardrobe: number; personal: number; tryOn: number; unknown: number };
  byCategory: Record<MediaCategory, number>;
  /** Desglose informativo de ORPHAN_CANDIDATE (no cambia su categoría). */
  orphanDetail: { ownerMissing: number; personalCitedOnlyBySourcePhoto: number };
  /** Referencias de PostgreSQL sin imagen en Cloudinary. null = no se puede afirmar (inventario o consulta incompletos). */
  brokenReferences: { total: number | null; wardrobe: number | null; personal: number | null; tryOn: number | null };
  /**
   * Referencias de las tres fuentes de verdad fuera de `ai-wardrobe/` (datos heredados o de ejemplo): no pueden estar en
   * el inventario recorrido. Solo depende de PostgreSQL; null = alguna de las tres consultas falló (recuento desconocido).
   */
  referencesOutsidePrefix: number | null;
  /** Solo códigos genéricos: nunca identificadores ni mensajes del proveedor. */
  errors: { stage: "inventory" | "database"; scope: string; code: string }[];
}

const KINDS: readonly MediaKind[] = ["wardrobe", "personal", "try-on"];
const EXPECTED_DELIVERY: Record<MediaKind, DeliveryType> = { wardrobe: "upload", personal: "authenticated", "try-on": "authenticated" };
/** `ai-wardrobe/<userId>/<tipo>/<nombre>`: un único nivel por debajo de la carpeta del tipo. */
const APP_PATH = /^ai-wardrobe\/([A-Za-z0-9_-]{1,64})\/(wardrobe|personal|try-on)\/[^/]+$/;

export const DEFAULT_GRACE_MS = 24 * 3_600_000;
/**
 * Presupuesto del INVENTARIO (todas las páginas, incluida la última petición: cada una se cancela al agotarse). Con
 * maxDuration = 300 s quedan ≥ 60 s de reserva para las consultas de PostgreSQL y la construcción del informe.
 */
export const DEFAULT_BUDGET_MS = 240_000;
const DEFAULTS = { graceMs: DEFAULT_GRACE_MS, maxPagesPerType: 200, budgetMs: DEFAULT_BUDGET_MS };
const TIMED_OUT = Symbol("timeout");

/**
 * Pide una página con el tiempo restante como límite estricto: al vencer se aborta la petición (cancelación real en
 * listAppResourcesPage) y se devuelve TIMED_OUT sin esperar a que el proveedor responda.
 */
async function pageWithin(listPage: ListPage, type: DeliveryType, cursor: string | undefined, ms: number): Promise<ResourcePage | typeof TIMED_OUT> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(new Error("TIME_BUDGET")); resolve(TIMED_OUT); }, ms);
  });
  const request = listPage(type, cursor, ctrl.signal);
  request.catch(() => undefined); // si vence el plazo, su rechazo posterior (ECONNRESET) no debe quedar sin capturar
  try {
    return await Promise.race([request, expired]);
  } finally {
    clearTimeout(timer);
  }
}

interface InventoryItem { publicId: string; delivery: DeliveryType; createdAt: Date | null; valid: boolean }

/** Código genérico para el informe y el log (sin mensajes del proveedor, que podrían contener identificadores). */
function inventoryErrorCode(err: unknown): string {
  const http = (err as { http_code?: unknown; error?: { http_code?: unknown } } | null);
  const code = http?.http_code ?? http?.error?.http_code;
  return typeof code === "number" ? `CLOUDINARY_${code}` : "CLOUDINARY_ERROR";
}

/** Recorre un tipo de entrega página a página; ante cualquier anomalía se detiene y lo marca incompleto. */
async function inventory(type: DeliveryType, listPage: ListPage, opts: { maxPages: number; deadline: number }, report: MediaReconcileReport) {
  const items: InventoryItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    if (report.pages[type] >= opts.maxPages) { report.errors.push({ stage: "inventory", scope: type, code: "PAGE_LIMIT" }); return { items, complete: false }; }
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) { report.errors.push({ stage: "inventory", scope: type, code: "TIME_BUDGET" }); return { items, complete: false }; }
    let page: ResourcePage;
    try {
      const got = await pageWithin(listPage, type, cursor, remaining);
      if (got === TIMED_OUT) { report.errors.push({ stage: "inventory", scope: type, code: "TIME_BUDGET" }); return { items, complete: false }; }
      page = got;
    } catch (err) {
      report.errors.push({ stage: "inventory", scope: type, code: inventoryErrorCode(err) });
      return { items, complete: false };
    }
    if (!page || !Array.isArray(page.resources)) { report.errors.push({ stage: "inventory", scope: type, code: "MALFORMED_PAGE" }); return { items, complete: false }; }
    report.pages[type]++;
    for (const raw of page.resources as unknown[]) {
      const r = raw as { public_id?: unknown; created_at?: unknown; type?: unknown } | null;
      const publicId = typeof r?.public_id === "string" ? r.public_id : null;
      const created = typeof r?.created_at === "string" ? new Date(r.created_at) : null;
      items.push({
        publicId: publicId ?? "",
        delivery: type,
        createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
        // Recurso que no es lo pedido (sin id, otro tipo de entrega o fuera del prefijo): no se puede atribuir.
        valid: publicId !== null && (r?.type === undefined || r.type === type) && publicId.startsWith(APP_ROOT_PREFIX),
      });
    }
    const next = page.next_cursor;
    if (next === undefined || next === null || next === "") return { items, complete: true };
    if (typeof next !== "string" || next === cursor) { report.errors.push({ stage: "inventory", scope: type, code: "BAD_CURSOR" }); return { items, complete: false }; }
    cursor = next;
  }
}

/** Ejecuta una consulta de solo lectura; si falla, lo registra (saneado) y devuelve null (= no verificable). */
async function readOrNull<T>(scope: string, report: MediaReconcileReport, query: () => Promise<T>): Promise<T | null> {
  try { return await query(); } catch (err) {
    const safe = safeDbError(err) as Error;
    report.errors.push({ stage: "database", scope, code: /\((P\d{4})\)/.exec(safe.message ?? "")?.[1] ?? "DB_ERROR" });
    return null;
  }
}

export async function detectOrphanMedia(opts: { now?: Date; graceMs?: number; maxPagesPerType?: number; budgetMs?: number; listPage?: ListPage } = {}): Promise<MediaReconcileReport> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? DEFAULTS.graceMs;
  const listPage = opts.listPage ?? listAppResourcesPage;
  const report: MediaReconcileReport = {
    startedAt: now.toISOString(), durationMs: 0, complete: false, inventoryComplete: { upload: false, authenticated: false },
    graceHours: graceMs / 3_600_000, pages: { upload: 0, authenticated: 0 }, resourcesExamined: 0,
    byKind: { wardrobe: 0, personal: 0, tryOn: 0, unknown: 0 },
    byCategory: { REFERENCED: 0, ORPHAN_CANDIDATE: 0, TOO_RECENT: 0, UNKNOWN: 0, INCOMPLETE: 0 },
    orphanDetail: { ownerMissing: 0, personalCitedOnlyBySourcePhoto: 0 },
    brokenReferences: { total: null, wardrobe: null, personal: null, tryOn: null },
    referencesOutsidePrefix: 0, errors: [],
  };
  const inv = { maxPages: opts.maxPagesPerType ?? DEFAULTS.maxPagesPerType, deadline: t0 + (opts.budgetMs ?? DEFAULTS.budgetMs) };

  // 1) Inventario (dos tipos de entrega, cada uno paginado de forma independiente).
  const pub = await inventory("upload", listPage, inv, report);
  const priv = await inventory("authenticated", listPage, inv, report);
  report.inventoryComplete = { upload: pub.complete, authenticated: priv.complete };
  const items = [...pub.items, ...priv.items];

  // 2) Referencias de PostgreSQL (SOLO lecturas; se seleccionan únicamente los identificadores).
  const parsed = items.map((it) => {
    const m = it.valid ? APP_PATH.exec(it.publicId) : null;
    return { ...it, userId: m?.[1] ?? null, kind: (m?.[2] as MediaKind | undefined) ?? null };
  });
  const ownerIds = [...new Set(parsed.flatMap((p) => (p.userId ? [p.userId] : [])))];
  const [wardrobeRefs, personalRefs, tryOnRefs, sourceCites, owners] = await Promise.all([
    readOrNull("wardrobe", report, async () => new Set((await prisma.wardrobeItem.findMany({ where: { imagePublicId: { not: null } }, select: { imagePublicId: true }, distinct: ["imagePublicId"] })).map((r) => r.imagePublicId!))),
    readOrNull("personal", report, async () => new Set((await prisma.userProfile.findMany({ select: { photoPublicIds: true } })).flatMap((r) => r.photoPublicIds))),
    readOrNull("try-on", report, async () => new Set((await prisma.generatedImage.findMany({ where: { publicId: { not: null } }, select: { publicId: true } })).map((r) => r.publicId!))),
    readOrNull("sourcePhoto", report, async () => new Set((await prisma.generatedImage.findMany({ where: { sourcePhotoId: { not: null } }, select: { sourcePhotoId: true }, distinct: ["sourcePhotoId"] })).map((r) => r.sourcePhotoId!))),
    readOrNull("owners", report, async () => new Set((await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true } })).map((u) => u.id))),
  ]);
  const refsByKind: Record<MediaKind, Set<string> | null> = { wardrobe: wardrobeRefs, personal: personalRefs, "try-on": tryOnRefs };

  // 3) Clasificación de cada recurso.
  for (const p of parsed) {
    report.resourcesExamined++;
    if (!p.kind || !p.userId || EXPECTED_DELIVERY[p.kind] !== p.delivery) { report.byKind.unknown++; report.byCategory.UNKNOWN++; continue; }
    report.byKind[p.kind === "try-on" ? "tryOn" : p.kind]++;
    const refs = refsByKind[p.kind];
    if (!refs) { report.byCategory.INCOMPLETE++; continue; } // la fuente de verdad no se pudo consultar
    if (refs.has(p.publicId)) { report.byCategory.REFERENCED++; continue; }
    if (!p.createdAt || !owners) { report.byCategory.INCOMPLETE++; continue; } // sin antigüedad o sin saber si el dueño existe
    if (now.getTime() - p.createdAt.getTime() < graceMs) { report.byCategory.TOO_RECENT++; continue; }
    report.byCategory.ORPHAN_CANDIDATE++;
    if (!owners.has(p.userId)) report.orphanDetail.ownerMissing++;
    if (p.kind === "personal" && sourceCites?.has(p.publicId)) report.orphanDetail.personalCitedOnlyBySourcePhoto++;
  }

  // 4) Referencias rotas: solo se afirman si el inventario de SU tipo de entrega está completo y la consulta fue bien.
  const inInventory: Record<DeliveryType, Set<string>> = {
    upload: new Set(pub.items.map((i) => i.publicId)), authenticated: new Set(priv.items.map((i) => i.publicId)),
  };
  const broken = (kind: MediaKind): number | null => {
    const refs = refsByKind[kind];
    const delivery = EXPECTED_DELIVERY[kind];
    if (!refs || !report.inventoryComplete[delivery]) return null;
    let n = 0;
    for (const id of refs) if (id.startsWith(APP_ROOT_PREFIX) && !inInventory[delivery].has(id)) n++;
    return n;
  };
  const b = { wardrobe: broken("wardrobe"), personal: broken("personal"), tryOn: broken("try-on") };
  report.brokenReferences = { ...b, total: b.wardrobe === null || b.personal === null || b.tryOn === null ? null : b.wardrobe + b.personal + b.tryOn };
  // Independiente del inventario: solo exige que las tres consultas de referencias hayan funcionado.
  report.referencesOutsidePrefix = KINDS.every((k) => refsByKind[k] !== null)
    ? KINDS.reduce((n, k) => n + [...refsByKind[k]!].filter((id) => !id.startsWith(APP_ROOT_PREFIX)).length, 0)
    : null;

  report.complete = pub.complete && priv.complete && report.errors.length === 0;
  report.durationMs = Date.now() - t0;
  if (report.errors.length) {
    logError("media.reconcile", new Error(`Inventario incompleto: ${report.errors.map((e) => `${e.stage}/${e.scope}/${e.code}`).join(", ")}`));
  }
  return report;
}

export const mediaReconcileService = { detectOrphanMedia, KINDS };
