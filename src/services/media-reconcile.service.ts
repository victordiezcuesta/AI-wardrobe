import { Prisma } from "@/generated/prisma/client";
import { APP_ROOT_PREFIX, listAppResourcesPage, type DeliveryType, type ResourcePage } from "@/lib/cloudinary";
import { parseImageUrl } from "@/lib/cloudinary/url";
import { env } from "@/lib/env";
import { logError } from "@/lib/errors";
import { safeDbError } from "@/lib/errors/db";
import { prisma } from "@/lib/prisma";

/**
 * Detector de imágenes huérfanas — ESTRICTAMENTE DE SOLO LECTURA.
 *
 * Recorre el inventario de Cloudinary bajo `ai-wardrobe/` (públicas y privadas, paginado) y lo compara con las fuentes
 * de verdad de PostgreSQL. No borra, mueve ni etiqueta nada en Cloudinary y no escribe en la base de datos.
 * Devuelve un informe AGREGADO (recuentos, sin publicId, userId ni URLs). La variante interna detectOrphanMediaDetailed
 * devuelve además las candidatas detalladas para la futura persistencia (nunca se exponen ni se registran).
 *
 * Fuentes de verdad (referencias de almacenamiento):
 * - wardrobe  (público)  → WardrobeItem.imagePublicId (varias prendas pueden compartir imagen);
 * - personal  (privado)  → UserProfile.photoPublicIds;
 * - try-on    (privado)  → GeneratedImage.publicId.
 * Referencias por URL (protegen, no cuentan como fuente de verdad): WardrobeItem.imageUrl/thumbUrl,
 * GeneratedImage.imageUrl, User.image, ShoppingProduct.imageUrl y CatalogProduct.imageUrl. Una URL propia protege su
 * recurso; una URL ambigua (no interpretable con seguridad) deja INCOMPLETE todo lo no referenciado de TODOS los
 * propietarios que menciona, o todo si no se pueden acotar (p. ej. una URL de nuestra cuenta sin indicios). Ver
 * `parseImageUrl`. `GeneratedImage.sourcePhotoId` es una cita histórica: solo se informa.
 *
 * Ningún recurso de una ejecución con el inventario o alguna consulta incompletos sale como ORPHAN_CANDIDATE. Los que
 * superan todas las demás comprobaciones y solo se detienen en la ÚLTIMA (ejecución incompleta) quedan INCOMPLETE y se
 * cuentan en `candidatesWithheld`; los que ya quedaron INCOMPLETE antes (fallo de su fuente de verdad, de las URLs o de
 * los propietarios, URL ambigua o metadatos obligatorios ausentes) no se cuentan ahí.
 */

export type MediaKind = "wardrobe" | "personal" | "try-on";
export type MediaCategory = "REFERENCED" | "ORPHAN_CANDIDATE" | "TOO_RECENT" | "UNKNOWN" | "INCOMPLETE" | "QUARANTINED";

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
  /** COMPLETE solo si los DOS inventarios llegaron a su última página sin anomalías. Una página recibida no basta. */
  inventoryStatus: "COMPLETE" | "INCOMPLETE";
  inventoryComplete: { upload: boolean; authenticated: boolean };
  graceHours: number;
  pages: { upload: number; authenticated: number };
  resourcesExamined: number;
  byKind: { wardrobe: number; personal: number; tryOn: number; unknown: number; quarantine: number };
  byCategory: Record<MediaCategory, number>;
  /**
   * Recursos retenidos SOLO en la última comprobación (superaron todas las demás, pero la ejecución no es completa):
   * quedan INCOMPLETE. NO es un recuento exhaustivo de posibles candidatos: los que quedaron INCOMPLETE antes por un
   * fallo de referencias, URLs o propietarios, una URL ambigua o metadatos ausentes no se incluyen.
   */
  candidatesWithheld: number;
  /** Desglose informativo de ORPHAN_CANDIDATE (no cambia su categoría). */
  orphanDetail: { ownerMissing: number; personalCitedOnlyBySourcePhoto: number };
  /** Por qué se protegió un recurso que no tiene referencia por publicId. */
  protection: { referencedByUrlOnly: number; ambiguousUrl: number; missingMetadata: number };
  /** Recursos en `ai-wardrobe/<userId>/_quarantine/<tipo>/…` (nunca huérfanas ordinarias). */
  quarantine: { wardrobe: number; personal: number; tryOn: number; publicDelivery: number };
  /** Cuántos recursos válidos traían cada metadato (no se inventa ninguno que falte). */
  metadata: { assetId: number; version: number; createdAt: number; bytes: number; format: number };
  /** URLs guardadas que se han examinado. null = la consulta falló (nada sin publicId puede salir candidata). */
  urlReferences: { scanned: number; own: number; ownOutsidePrefix: number; external: number; ambiguous: number } | null;
  /** Referencias de PostgreSQL sin imagen en Cloudinary. null = no se puede afirmar (inventario o consulta incompletos). */
  brokenReferences: { total: number | null; wardrobe: number | null; personal: number | null; tryOn: number | null };
  /**
   * Referencias de las tres fuentes de verdad fuera de `ai-wardrobe/` (datos heredados o de ejemplo): no pueden estar en
   * el inventario recorrido. Solo depende de PostgreSQL; null = alguna de las tres consultas falló (recuento desconocido).
   */
  referencesOutsidePrefix: number | null;
  /**
   * Cuota de la Admin API según la ÚLTIMA respuesta correcta (cabeceras X-FeatureRateLimit-* que copia el SDK). null si
   * ninguna respuesta las trajo; los errores (420 incluido) no las exponen.
   */
  rateLimit: { allowed: number | null; remaining: number | null; resetAt: string | null } | null;
  /** Solo códigos genéricos: nunca identificadores ni mensajes del proveedor. */
  errors: { stage: "inventory" | "database"; scope: string; code: string }[];
}

const KINDS: readonly MediaKind[] = ["wardrobe", "personal", "try-on"];
const EXPECTED_DELIVERY: Record<MediaKind, DeliveryType> = { wardrobe: "upload", personal: "authenticated", "try-on": "authenticated" };
/** Identificador de propietario: no puede empezar por `_` (reservado para carpetas internas como `_quarantine`). */
const OWNER = "[A-Za-z0-9-][A-Za-z0-9_-]{0,63}";
/** `ai-wardrobe/<userId>/<tipo>/<nombre>`: un único nivel por debajo de la carpeta del tipo. */
const APP_PATH = new RegExp(`^ai-wardrobe/(${OWNER})/(wardrobe|personal|try-on)/[^/]+$`);
/** `ai-wardrobe/<userId>/_quarantine/<tipo>/<nombre>`: reservado para la cuarentena (fases futuras). */
const QUARANTINE_PATH = new RegExp(`^ai-wardrobe/(${OWNER})/_quarantine/(wardrobe|personal|try-on)/[^/]+$`);

export const DEFAULT_GRACE_MS = 24 * 3_600_000;
/** Mínimo absoluto: ninguna configuración puede bajar de aquí (las peticiones que suben antes de referenciar duran ≤ 300 s). */
export const MIN_GRACE_MS = 3_600_000;
/** Periodo de gracia efectivo: el configurado, pero nunca por debajo del mínimo; un valor no numérico usa el de defecto. */
export function effectiveGraceMs(configured?: number): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_GRACE_MS;
  return Math.max(configured, MIN_GRACE_MS);
}
/**
 * Presupuesto del INVENTARIO (todas las páginas, incluida la última petición: cada una se cancela al agotarse). Con
 * maxDuration = 300 s quedan ≥ 60 s de reserva para las consultas de PostgreSQL y la construcción del informe.
 */
export const DEFAULT_BUDGET_MS = 240_000;
const DEFAULTS = { maxPagesPerType: 200, budgetMs: DEFAULT_BUDGET_MS };
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
  try {
    const request = listPage(type, cursor, ctrl.signal);
    request.catch(() => undefined); // si vence el plazo, su rechazo posterior (ECONNRESET) no debe quedar sin capturar
    return await Promise.race([request, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Un recurso del inventario con sus metadatos tal como llegaron (null = no venía o no era válido; nunca se inventa). */
export interface InventoryItem {
  publicId: string;
  /** Tipo de entrega por el que se pidió la página. */
  delivery: DeliveryType;
  assetId: string | null;
  version: number | null;
  createdAt: Date | null;
  bytes: number | null;
  format: string | null;
  resourceType: string | null;
  /** `type` tal como lo informó la API (null si no venía). */
  type: string | null;
}

export type NormalizedResource =
  | { ok: true; item: InventoryItem }
  | { ok: false; code: "MALFORMED_RESOURCE" | "UNEXPECTED_RESOURCE" };

const optString = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const optInt = (v: unknown, min: number) => (typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : null);

/**
 * `asset_id` se trata como un identificador OPACO: no se presupone ningún formato (ni el SDK ni el repositorio documentan
 * uno) y solo se compara por igualdad exacta entre observaciones. Validación conservadora, sin normalizar ni transformar
 * el valor: texto de 1 a MAX_ASSET_ID_LENGTH unidades UTF-16, sin espacios en blanco, caracteres de control, caracteres
 * de formato invisibles ni surrogates sueltos (harían que dos valores aparentemente iguales no lo fueran). Cualquier otro
 * valor → null: el recurso queda INCOMPLETE y nunca puede convertirse en candidato.
 */
export const MAX_ASSET_ID_LENGTH = 128;
const ASSET_ID_FORBIDDEN = /[\s\p{Cc}\p{Cf}\p{Cs}]/u;
export function parseOpaqueAssetId(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ASSET_ID_LENGTH) return null;
  return ASSET_ID_FORBIDDEN.test(v) ? null : v;
}
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
/**
 * Fecha ISO 8601 en UTC con `Z` (fracción de segundo opcional), sin espacios, y REAL: los componentes deben coincidir
 * tras construirla (rechaza 2026-02-30, 25:00, segundos 60, años < 1970…). Cualquier otra cosa → null. No se usa
 * `new Date(texto)` como validador: acepta "1", "2026" o "Nov 1" y aplica la zona horaria local a fechas sin `Z`.
 */
export function parseUtcTimestamp(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = ISO_UTC.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  if (y < 1970) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms));
  const same = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === se;
  return same ? date : null;
}

/**
 * Valida un recurso de la Admin API (su tipado es `any`). MALFORMED: sin `public_id` utilizable o con `type`/
 * `resource_type` que no son texto. UNEXPECTED: no es lo que se pidió (otro tipo de entrega, no es imagen o fuera del
 * prefijo). Cualquier metadato ausente o inválido queda en null: nunca se rellena con lo que se pidió al endpoint.
 * OBLIGATORIOS para clasificar (si falta alguno, el recurso queda INCOMPLETE): `asset_id` (opaco, ver parseOpaqueAssetId), `created_at`
 * (ISO UTC estricto), `type` (== el pedido) y `resource_type` (== "image"). Informativos: `version`, `bytes`, `format`.
 */
export function normalizeResource(raw: unknown, requested: DeliveryType): NormalizedResource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "MALFORMED_RESOURCE" };
  const r = raw as Record<string, unknown>;
  const publicId = optString(r.public_id, 1024);
  if (publicId === null) return { ok: false, code: "MALFORMED_RESOURCE" };
  if ((r.type !== undefined && typeof r.type !== "string") || (r.resource_type !== undefined && typeof r.resource_type !== "string")) {
    return { ok: false, code: "MALFORMED_RESOURCE" };
  }
  if ((r.type !== undefined && r.type !== requested) || (r.resource_type !== undefined && r.resource_type !== "image") || !publicId.startsWith(APP_ROOT_PREFIX)) {
    return { ok: false, code: "UNEXPECTED_RESOURCE" };
  }
  return {
    ok: true,
    item: {
      publicId, delivery: requested,
      assetId: parseOpaqueAssetId(r.asset_id),
      version: optInt(r.version, 1),
      createdAt: parseUtcTimestamp(r.created_at),
      bytes: optInt(r.bytes, 0),
      format: optString(r.format, 16),
      resourceType: (r.resource_type as string | undefined) ?? null,
      type: (r.type as string | undefined) ?? null,
    },
  };
}

/** Código genérico para el informe y el log (sin mensajes del proveedor, que podrían contener identificadores). */
function inventoryErrorCode(err: unknown): string {
  const http = (err as { http_code?: unknown; error?: { http_code?: unknown } } | null);
  const code = http?.http_code ?? http?.error?.http_code;
  return typeof code === "number" ? `CLOUDINARY_${code}` : "CLOUDINARY_ERROR";
}

/** Cuota informada por el SDK en una respuesta correcta; null si no trae ninguno de los tres datos válidos. */
function readRateLimit(page: ResourcePage): MediaReconcileReport["rateLimit"] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const at = page.rate_limit_reset_at;
  const date = at instanceof Date ? at : typeof at === "string" ? new Date(at) : null;
  const out = { allowed: num(page.rate_limit_allowed), remaining: num(page.rate_limit_remaining), resetAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null };
  return out.allowed === null && out.remaining === null && out.resetAt === null ? null : out;
}

type Entry = { ok: true; item: InventoryItem } | { ok: false };

/** Recorre un tipo de entrega página a página; ante cualquier anomalía lo marca incompleto (y se detiene si no puede seguir). */
async function inventory(type: DeliveryType, listPage: ListPage, opts: { maxPages: number; deadline: number }, report: MediaReconcileReport) {
  const entries: Entry[] = [];
  const anomalies = new Set<string>();
  const fail = (code: string) => { report.errors.push({ stage: "inventory", scope: type, code }); return { entries, complete: false }; };
  let cursor: string | undefined;
  for (;;) {
    if (report.pages[type] >= opts.maxPages) return fail("PAGE_LIMIT");
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) return fail("TIME_BUDGET");
    let page: ResourcePage;
    try {
      const got = await pageWithin(listPage, type, cursor, remaining);
      if (got === TIMED_OUT) return fail("TIME_BUDGET");
      page = got;
    } catch (err) {
      return fail(inventoryErrorCode(err));
    }
    if (!page || typeof page !== "object" || !Array.isArray(page.resources)) return fail("MALFORMED_PAGE");
    report.pages[type]++;
    report.rateLimit = readRateLimit(page) ?? report.rateLimit;
    for (const raw of page.resources as unknown[]) {
      const n = normalizeResource(raw, type);
      if (n.ok) entries.push(n);
      else {
        entries.push({ ok: false });
        if (!anomalies.has(n.code)) { anomalies.add(n.code); report.errors.push({ stage: "inventory", scope: type, code: n.code }); }
      }
    }
    const next = page.next_cursor;
    // Solo la ausencia de cursor en una página bien formada cierra el inventario; con anomalías, nunca es completo.
    if (next === undefined || next === null || next === "") return { entries, complete: anomalies.size === 0 };
    if (typeof next !== "string" || next === cursor) return fail("BAD_CURSOR");
    cursor = next;
  }
}

/** Cliente con el que se hace UNA lectura del detector: el global, o la transacción acotada de esa lectura. */
type ReadDb = Prisma.TransactionClient;
/** Ejecuta una lectura con el cliente adecuado (sin límite: el global, como siempre; con límite: ver boundedReader). */
type Reader = <T>(query: (db: ReadDb) => Promise<T>) => Promise<T>;
/** Se agotó el presupuesto de las lecturas de PostgreSQL (antes de empezar o mientras se esperaba la respuesta). */
class QueryBudgetExceeded extends Error {}
const unboundedReader: Reader = (query) => query(prisma);

/**
 * Lecturas con límite EFECTIVO en PostgreSQL (solo si se pide `queryBudgetMs`): cada lectura va en su propia transacción
 * corta, de solo lectura (`transaction_read_only`), con `statement_timeout` local igual al tiempo que queda hasta
 * `deadline`: al vencer, PostgreSQL cancela la sentencia (SQLSTATE 57014) y libera la conexión. Además, la espera de
 * conexión (`maxWait`) y la transacción (`timeout`) de Prisma quedan acotadas a ese mismo tiempo, y la promesa deja de
 * esperarse al vencer el plazo. Cada lectura sigue siendo una única sentencia independiente (READ COMMITTED), igual que
 * sin límite: no hay ninguna transacción global ni cambia la semántica.
 */
function boundedReader(deadline: number): Reader {
  return async (query) => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new QueryBudgetExceeded();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new QueryBudgetExceeded()), ms); });
    const run = prisma.$transaction(async (tx) => {
      const left = Math.max(1, Math.floor(deadline - Date.now())); // lo que queda tras esperar la conexión
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${left}ms`}, true), set_config('transaction_read_only', 'on', true)`;
      return query(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: Math.ceil(ms), timeout: Math.ceil(ms) });
    run.catch(() => undefined); // si vence antes, su rechazo posterior no debe quedar sin capturar
    let result: Awaited<typeof run>;
    try { result = await Promise.race([run, expired]); } finally { clearTimeout(timer); }
    // Una respuesta que llega después del plazo tampoco vale (la ejecución no puede salir completa con ella).
    if (Date.now() > deadline) throw new QueryBudgetExceeded();
    return result;
  };
}

/** Cancelación de PostgreSQL por statement_timeout (57014) o fin de la transacción de Prisma por su límite (P2028). */
function isQueryTimeout(err: unknown): boolean {
  if (err instanceof QueryBudgetExceeded) return true;
  const e = err as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } } } | null;
  const cause = e?.meta?.driverAdapterError?.cause;
  return e?.code === "P2028" || cause?.originalCode === "57014" || cause?.code === "57014";
}

/**
 * Ejecuta una consulta de solo lectura; si falla, lo registra (saneado) y devuelve null (= no verificable). Con límite,
 * una lectura que lo agota (o falla después de agotarlo) se registra como QUERY_TIMEOUT: la ejecución nunca es completa.
 */
async function readOrNull<T>(scope: string, report: MediaReconcileReport, query: () => Promise<T>, deadline: number | null = null): Promise<T | null> {
  try { return await query(); } catch (err) {
    if (deadline !== null && (isQueryTimeout(err) || Date.now() >= deadline)) {
      report.errors.push({ stage: "database", scope, code: "QUERY_TIMEOUT" });
      return null;
    }
    const safe = safeDbError(err) as Error;
    report.errors.push({ stage: "database", scope, code: /\((P\d{4})\)/.exec(safe.message ?? "")?.[1] ?? "DB_ERROR" });
    return null;
  }
}

/**
 * TODAS las URLs de imagen guardadas, sin filtrar por texto en SQL: un filtro (p. ej. «contiene cloudinary») dejaría
 * fuera variantes que el intérprete sí reconoce (host o carpeta con codificación %). En compras y catálogo se leen
 * valores distintos para no repetir la misma URL de producto.
 */
async function storedImageUrls(read: Reader): Promise<(string | null)[]> {
  const [items, generated, users, shopping, catalog] = await Promise.all([
    read((db) => db.wardrobeItem.findMany({ where: { OR: [{ imageUrl: { not: null } }, { thumbUrl: { not: null } }] }, select: { imageUrl: true, thumbUrl: true } })),
    read((db) => db.generatedImage.findMany({ where: { imageUrl: { not: null } }, select: { imageUrl: true } })),
    read((db) => db.user.findMany({ where: { image: { not: null } }, select: { image: true } })),
    read((db) => db.shoppingProduct.findMany({ where: { imageUrl: { not: null } }, select: { imageUrl: true }, distinct: ["imageUrl"] })),
    read((db) => db.catalogProduct.findMany({ select: { imageUrl: true }, distinct: ["imageUrl"] })),
  ]);
  return [
    ...items.flatMap((i) => [i.imageUrl, i.thumbUrl]), ...generated.map((g) => g.imageUrl), ...users.map((u) => u.image),
    ...shopping.map((s) => s.imageUrl), ...catalog.map((c) => c.imageUrl),
  ];
}

interface UrlProtection { ids: Set<string>; owners: Set<string>; all: boolean; stats: NonNullable<MediaReconcileReport["urlReferences"]> }

function urlProtection(urls: (string | null)[], cloudName: string): UrlProtection {
  const p: UrlProtection = { ids: new Set(), owners: new Set(), all: false, stats: { scanned: 0, own: 0, ownOutsidePrefix: 0, external: 0, ambiguous: 0 } };
  for (const u of urls) {
    if (u === null) continue;
    p.stats.scanned++;
    const ref = parseImageUrl(u, cloudName);
    if (ref.kind === "external") p.stats.external++;
    else if (ref.kind === "ambiguous") {
      p.stats.ambiguous++;
      if (ref.ownerIds) for (const o of ref.ownerIds) p.owners.add(o); else p.all = true;
    } else if (!ref.insidePrefix) p.stats.ownOutsidePrefix++;
    else { p.stats.own++; for (const id of ref.publicIds) p.ids.add(id); }
  }
  return p;
}

/**
 * Candidata DEMOSTRADA (solo ORPHAN_CANDIDATE de una ejecución completa) con lo necesario para persistirla. Uso INTERNO:
 * nunca forma parte del informe, de respuestas HTTP, de logs ni de errores (contiene identificadores).
 * - `ownerUserId`: el de la ruta `ai-wardrobe/<userId>/…`. `ownerMissing`: la consulta de propietarios funcionó y ese
 *   usuario no existe (si la consulta falla, el recurso queda INCOMPLETE y no hay candidata).
 * - `assetId`: el valor opaco tal como llegó (validado, sin normalizar). `version`, `bytes` y `format`: null si no venían.
 */
export interface MediaCandidate {
  publicId: string;
  delivery: DeliveryType;
  kind: MediaKind;
  ownerUserId: string;
  ownerMissing: boolean;
  assetId: string;
  version: number | null;
  bytes: number | null;
  format: string | null;
  resourceCreatedAt: Date;
}
export interface DetailedDetection { report: MediaReconcileReport; candidates: readonly Readonly<MediaCandidate>[] }
/**
 * `queryBudgetMs` (opcional): activa el límite efectivo de las lecturas de PostgreSQL (ver boundedReader). Todas deben
 * terminar antes de `inicio + budgetMs + queryBudgetMs`, así que inventario y lecturas juntos nunca superan esa suma.
 * Sin él, las lecturas se hacen como siempre (cliente global, sin límite propio).
 */
type DetectOpts = { now?: Date; graceMs?: number; maxPagesPerType?: number; budgetMs?: number; queryBudgetMs?: number; listPage?: ListPage };

/** Informe AGREGADO (contrato público del endpoint): sin identificadores, URLs ni datos personales. */
export async function detectOrphanMedia(opts: DetectOpts = {}): Promise<MediaReconcileReport> {
  return run(opts, null);
}

/**
 * Variante INTERNA para la reconciliación persistente: el mismo informe más las candidatas detalladas. `now` es
 * obligatorio y debe ser el `startedAt` del lease (reloj de PostgreSQL): la antigüedad nunca se calcula con el reloj de
 * Node. Se copia al empezar, así que ni el reloj del sistema ni cambios posteriores en el objeto recibido la alteran.
 */
export async function detectOrphanMediaDetailed(opts: DetectOpts & { now: Date }): Promise<DetailedDetection> {
  if (!(opts?.now instanceof Date) || Number.isNaN(opts.now.getTime())) throw new TypeError("detectOrphanMediaDetailed requiere `now` (startedAt del lease)");
  const candidates: MediaCandidate[] = [];
  const report = await run(opts, candidates);
  return { report, candidates: Object.freeze(candidates.map((c) => Object.freeze(c))) };
}

async function run(opts: DetectOpts, candidates: MediaCandidate[] | null): Promise<MediaReconcileReport> {
  const t0 = Date.now();
  const now = new Date((opts.now ?? new Date()).getTime()); // copia: el instante de referencia no puede cambiar a mitad
  const graceMs = effectiveGraceMs(opts.graceMs);
  const listPage = opts.listPage ?? listAppResourcesPage;
  const report: MediaReconcileReport = {
    startedAt: now.toISOString(), durationMs: 0, complete: false, inventoryStatus: "INCOMPLETE",
    inventoryComplete: { upload: false, authenticated: false },
    graceHours: graceMs / 3_600_000, pages: { upload: 0, authenticated: 0 }, resourcesExamined: 0,
    byKind: { wardrobe: 0, personal: 0, tryOn: 0, unknown: 0, quarantine: 0 },
    byCategory: { REFERENCED: 0, ORPHAN_CANDIDATE: 0, TOO_RECENT: 0, UNKNOWN: 0, INCOMPLETE: 0, QUARANTINED: 0 },
    candidatesWithheld: 0,
    orphanDetail: { ownerMissing: 0, personalCitedOnlyBySourcePhoto: 0 },
    protection: { referencedByUrlOnly: 0, ambiguousUrl: 0, missingMetadata: 0 },
    quarantine: { wardrobe: 0, personal: 0, tryOn: 0, publicDelivery: 0 },
    metadata: { assetId: 0, version: 0, createdAt: 0, bytes: 0, format: 0 },
    urlReferences: null,
    brokenReferences: { total: null, wardrobe: null, personal: null, tryOn: null },
    referencesOutsidePrefix: 0, rateLimit: null, errors: [],
  };
  const inv = { maxPages: opts.maxPagesPerType ?? DEFAULTS.maxPagesPerType, deadline: t0 + (opts.budgetMs ?? DEFAULTS.budgetMs) };
  const qb = opts.queryBudgetMs;
  if (qb !== undefined && !(Number.isSafeInteger(qb) && qb >= 1)) throw new TypeError("queryBudgetMs debe ser un entero positivo");
  const queryDeadline = qb === undefined ? null : inv.deadline + qb;
  const read: Reader = queryDeadline === null ? unboundedReader : boundedReader(queryDeadline);

  // 1) Inventario (dos tipos de entrega, cada uno paginado de forma independiente).
  const pub = await inventory("upload", listPage, inv, report);
  const priv = await inventory("authenticated", listPage, inv, report);
  report.inventoryComplete = { upload: pub.complete, authenticated: priv.complete };
  report.inventoryStatus = pub.complete && priv.complete ? "COMPLETE" : "INCOMPLETE";
  const entries = [...pub.entries, ...priv.entries];

  // 2) Referencias de PostgreSQL (SOLO lecturas; se seleccionan únicamente identificadores y URLs).
  const parsed = entries.map((e) => {
    if (!e.ok) return { item: null, userId: null, kind: null, quarantine: false };
    const q = QUARANTINE_PATH.exec(e.item.publicId);
    const m = q ?? APP_PATH.exec(e.item.publicId);
    return { item: e.item, userId: m?.[1] ?? null, kind: (m?.[2] as MediaKind | undefined) ?? null, quarantine: !!q };
  });
  const ownerIds = [...new Set(parsed.flatMap((p) => (p.userId && !p.quarantine ? [p.userId] : [])))];
  const cloudName = env().CLOUDINARY_CLOUD_NAME;
  const [wardrobeRefs, personalRefs, tryOnRefs, sourceCites, owners, urls] = await Promise.all([
    readOrNull("wardrobe", report, async () => new Set((await read((db) => db.wardrobeItem.findMany({ where: { imagePublicId: { not: null } }, select: { imagePublicId: true }, distinct: ["imagePublicId"] }))).map((r) => r.imagePublicId!)), queryDeadline),
    readOrNull("personal", report, async () => new Set((await read((db) => db.userProfile.findMany({ select: { photoPublicIds: true } }))).flatMap((r) => r.photoPublicIds)), queryDeadline),
    readOrNull("try-on", report, async () => new Set((await read((db) => db.generatedImage.findMany({ where: { publicId: { not: null } }, select: { publicId: true } }))).map((r) => r.publicId!)), queryDeadline),
    readOrNull("sourcePhoto", report, async () => new Set((await read((db) => db.generatedImage.findMany({ where: { sourcePhotoId: { not: null } }, select: { sourcePhotoId: true }, distinct: ["sourcePhotoId"] }))).map((r) => r.sourcePhotoId!)), queryDeadline),
    readOrNull("owners", report, async () => new Set((await read((db) => db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true } }))).map((u) => u.id)), queryDeadline),
    readOrNull("urls", report, () => storedImageUrls(read), queryDeadline),
  ]);
  const refsByKind: Record<MediaKind, Set<string> | null> = { wardrobe: wardrobeRefs, personal: personalRefs, "try-on": tryOnRefs };
  const byUrl = urls ? urlProtection(urls, cloudName) : null;
  report.urlReferences = byUrl?.stats ?? null;
  // Todo lo anterior ya terminó: si hay cualquier error (inventario o consulta), nada puede salir como candidata.
  const actionable = pub.complete && priv.complete && report.errors.length === 0;

  // 3) Clasificación de cada recurso.
  for (const p of parsed) {
    report.resourcesExamined++;
    const it = p.item;
    if (it) {
      if (it.assetId) report.metadata.assetId++;
      if (it.version !== null) report.metadata.version++;
      if (it.createdAt) report.metadata.createdAt++;
      if (it.bytes !== null) report.metadata.bytes++;
      if (it.format) report.metadata.format++;
    }
    if (it && p.quarantine && p.kind) {
      report.byKind.quarantine++; report.byCategory.QUARANTINED++;
      report.quarantine[p.kind === "try-on" ? "tryOn" : p.kind]++;
      if (it.delivery === "upload") report.quarantine.publicDelivery++;
      continue;
    }
    if (!it || !p.kind || !p.userId || EXPECTED_DELIVERY[p.kind] !== it.delivery) { report.byKind.unknown++; report.byCategory.UNKNOWN++; continue; }
    report.byKind[p.kind === "try-on" ? "tryOn" : p.kind]++;
    const refs = refsByKind[p.kind];
    if (!refs) { report.byCategory.INCOMPLETE++; continue; } // la fuente de verdad no se pudo consultar
    if (refs.has(it.publicId)) { report.byCategory.REFERENCED++; continue; }
    if (!byUrl) { report.byCategory.INCOMPLETE++; continue; } // no se sabe si alguna URL la usa
    if (byUrl.ids.has(it.publicId)) { report.byCategory.REFERENCED++; report.protection.referencedByUrlOnly++; continue; }
    if (byUrl.all || byUrl.owners.has(p.userId)) { report.byCategory.INCOMPLETE++; report.protection.ambiguousUrl++; continue; }
    // Metadatos OBLIGATORIOS para clasificar (version, bytes y format solo son informativos).
    if (!it.createdAt || !it.assetId || it.type === null || it.resourceType === null) { report.byCategory.INCOMPLETE++; report.protection.missingMetadata++; continue; }
    if (!owners) { report.byCategory.INCOMPLETE++; continue; } // sin saber si el dueño existe
    if (now.getTime() - it.createdAt.getTime() < graceMs) { report.byCategory.TOO_RECENT++; continue; }
    // Última comprobación: la ejecución debe ser completa. Solo aquí se cuenta candidatesWithheld.
    if (!actionable) { report.byCategory.INCOMPLETE++; report.candidatesWithheld++; continue; }
    report.byCategory.ORPHAN_CANDIDATE++;
    const ownerMissing = !owners.has(p.userId);
    if (ownerMissing) report.orphanDetail.ownerMissing++;
    candidates?.push({
      publicId: it.publicId, delivery: it.delivery, kind: p.kind, ownerUserId: p.userId, ownerMissing, assetId: it.assetId,
      version: it.version, bytes: it.bytes, format: it.format, resourceCreatedAt: new Date(it.createdAt.getTime()),
    });
    if (p.kind === "personal" && sourceCites?.has(it.publicId)) report.orphanDetail.personalCitedOnlyBySourcePhoto++;
  }

  // 4) Referencias rotas: solo se afirman si el inventario de SU tipo de entrega está completo y la consulta fue bien.
  const inInventory: Record<DeliveryType, Set<string>> = {
    upload: new Set(pub.entries.flatMap((e) => (e.ok ? [e.item.publicId] : []))),
    authenticated: new Set(priv.entries.flatMap((e) => (e.ok ? [e.item.publicId] : []))),
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

  report.complete = actionable;
  report.durationMs = Date.now() - t0;
  if (report.errors.length) {
    logError("media.reconcile", new Error(`Inventario incompleto: ${report.errors.map((e) => `${e.stage}/${e.scope}/${e.code}`).join(", ")}`));
  }
  return report;
}

export const mediaReconcileService = { detectOrphanMedia, KINDS };
