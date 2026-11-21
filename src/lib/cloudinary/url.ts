/**
 * Interpretación CONSERVADORA de URLs de imagen guardadas en la base de datos (sin red ni configuración: función pura).
 *
 * Sirve al detector de huérfanas para tratar como referencia cualquier URL que pueda apuntar a un recurso de NUESTRA
 * cuenta bajo `ai-wardrobe/`, aunque la fila no tenga `publicId` (datos heredados o de ejemplo). Formatos exactos:
 *
 *   https://res[-N].cloudinary.com/<cloud>/image/<upload|authenticated|private>/[s--firma--/][transformaciones/…][v123/]<public_id>[.ext]
 *   https://api.cloudinary.com/v1_1/<cloud>/image/download?…&public_id=<public_id>&type=<tipo>   (descarga firmada)
 *
 * Resultado:
 * - `external`: no puede ser de nuestra cuenta bajo `ai-wardrobe/` (otra cuenta de Cloudinary, u otro host sin ninguna
 *   mención de `ai-wardrobe`).
 * - `own`: de nuestra cuenta e interpretada POR COMPLETO (cada parte decodifica de forma estricta). `publicIds` son los ids
 *   que hay que proteger (con y sin la extensión final) e `insidePrefix` indica si está bajo `ai-wardrobe/`.
 * - `ambiguous`: no se puede interpretar con seguridad y podría ser nuestra. `ownerIds` son TODOS los propietarios que
 *   menciona; `null` = protección global (no se puede acotar el propietario). Nunca se inventa un id exacto.
 *
 * Los indicios de propietario nunca salen de decodificar la URL entera: se analizan por separado los segmentos de ruta,
 * las claves y valores del query y el fragmento, con una decodificación TOLERANTE (una secuencia `%` inválida en una
 * parte no impide leer las demás ni el resto de esa parte).
 */
export type ImageUrlRef =
  | { kind: "external" }
  | { kind: "own"; publicIds: string[]; delivery: string | null; insidePrefix: boolean }
  | { kind: "ambiguous"; ownerIds: string[] | null };

const APP_SEGMENT = "ai-wardrobe";
const RES_HOST = /^res(-\d{1,2})?\.cloudinary\.com$/;
const API_HOST = "api.cloudinary.com";
const DELIVERY = new Set(["upload", "authenticated", "private"]);
const SIGNATURE = /^s--[A-Za-z0-9_-]{8,64}--$/;
const VERSION = /^v\d{1,12}$/;
/** Un parámetro de transformación (`w_480`, `c_fill`, `q_auto:good`, `$var_3`…); un segmento es una lista separada por comas. */
const TRANSFORMATION_PARAM = /^(\$[a-z][A-Za-z0-9_]*|[a-z]{1,3})_[^/]*$/;
/**
 * Mención de la carpeta de la app (seguida de separador, fin o un `%` que quedó sin decodificar: un byte inválido justo
 * detrás no la oculta) y, si lo hay, su propietario (`/` o `:` como en `l_…`).
 */
const MENTION = /ai-wardrobe(?=$|[/:%])/g;
const OWNER_HINT = /ai-wardrobe[/:]([A-Za-z0-9_-]{1,64})/g;
/**
 * Un propietario solo se da por COMPLETO si termina en fin de parte o en un separador ASCII. Si lo sigue un `%` que quedó
 * sin decodificar (byte inválido o UTF-8 truncado), otro carácter de identificador (supera 64) o un carácter no ASCII,
 * podría ser solo el prefijo del identificador real: no se acota (protección global).
 */
const ownerComplete = (p: string, end: number) => end >= p.length || (/^[\x00-\x7F]$/.test(p[end]!) && !/^[A-Za-z0-9_%-]$/.test(p[end]!));

const EXTERNAL: ImageUrlRef = { kind: "external" };

/** Decodificación estricta de UNA parte; null si no es válida. */
function strict(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * Decodificación tolerante de UNA parte (nunca lanza): cada tramo `%XX…` que forme UTF-8 válido se decodifica entero. Si
 * un tramo no lo forma (p. ej. `%2F%FF`), se decodifican uno a uno los bytes ASCII (`%00`–`%7F`) y los demás se dejan
 * tal cual: un byte inválido no puede ocultar un separador o una letra codificados que formen una mención.
 */
function tolerant(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    strict(run) ?? run.replace(/%([0-9A-Fa-f]{2})/g, (byte, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : byte;
    }));
}

/**
 * Partes analizables (ya decodificadas de forma tolerante) de una URL: ruta (por segmentos), query (por pares), fragmento
 * y credenciales (`usuario:contraseña` como UNA parte, para que `ai-wardrobe:<id>@host` conserve su propietario).
 */
function partsOf(url: URL | null, raw: string): string[] {
  if (!url) return [raw.split("/").map(tolerant).join("/")];
  const path = url.pathname.split("/").map(tolerant).join("/");
  const query = url.search.slice(1).split("&").flatMap((pair) => {
    const i = pair.indexOf("=");
    return i === -1 ? [tolerant(pair)] : [tolerant(pair.slice(0, i)), tolerant(pair.slice(i + 1))];
  });
  const userinfo = url.username || url.password ? `${tolerant(url.username)}:${tolerant(url.password)}` : "";
  return [path, ...query, tolerant(url.hash.slice(1)), userinfo].filter((p) => p !== "");
}

/**
 * Ambigüedad a partir de los indicios. Sin ninguna mención de `ai-wardrobe` → null (no hay indicio de que sea nuestra).
 * Si alguna mención no lleva un propietario válido (ausente o reservado con `_`), la protección es global.
 */
function evidence(parts: string[]): ImageUrlRef | null {
  let mentions = 0;
  const owners = new Set<string>();
  let unknownOwner = false;
  for (const p of parts) {
    mentions += [...p.matchAll(MENTION)].length;
    for (const m of p.matchAll(OWNER_HINT)) {
      const h = m[1]!;
      if (h.startsWith("_") || !ownerComplete(p, m.index + m[0].length)) unknownOwner = true; else owners.add(h);
    }
  }
  if (mentions === 0) return null;
  const withOwner = parts.reduce((n, p) => n + [...p.matchAll(OWNER_HINT)].length, 0);
  return { kind: "ambiguous", ownerIds: unknownOwner || withOwner < mentions || owners.size === 0 ? null : [...owners].sort() };
}

const isTransformation = (seg: string) => seg.split(",").every((p) => TRANSFORMATION_PARAM.test(p));

function candidates(publicId: string): string[] {
  const last = publicId.slice(publicId.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? [publicId, publicId.slice(0, publicId.length - (last.length - dot))] : [publicId];
}

/** Query en pares decodificados ESTRICTAMENTE; null si alguna clave o valor no decodifica. */
function strictQuery(url: URL): [string, string][] | null {
  const out: [string, string][] = [];
  for (const pair of url.search.slice(1).split("&")) {
    if (pair === "") continue;
    const i = pair.indexOf("=");
    const k = strict((i === -1 ? pair : pair.slice(0, i)).replace(/\+/g, " "));
    const v = strict((i === -1 ? "" : pair.slice(i + 1)).replace(/\+/g, " "));
    if (k === null || v === null) return null;
    out.push([k, v]);
  }
  return out;
}

/** Menciones de la carpeta en TODAS las partes analizables (ruta, query, fragmento y credenciales). */
const mentionsIn = (url: URL) => partsOf(url, url.href).reduce((n, p) => n + [...p.matchAll(MENTION)].length, 0);

/**
 * Interpretación exacta de una URL de nuestra cuenta; null si cualquier detalle no encaja (→ ambigua). Una referencia
 * exacta exige que la ÚNICA mención de la carpeta en toda la URL sea la del propio id: cualquier otra (query, fragmento,
 * credenciales o la propia ruta) podría citar otro recurso u otro propietario.
 */
function parseOwnRes(segs: string[], url: URL): ImageUrlRef | null {
  const [, resourceType, delivery, ...rest] = segs;
  if (resourceType !== "image" || !delivery || !DELIVERY.has(delivery)) return null;
  if (segs.some((s) => s.includes("/"))) return null; // barra codificada: no se presupone cómo la interpreta el CDN
  const query = strictQuery(url);
  if (query === null || strict(url.hash.slice(1)) === null) return null; // alguna parte no decodifica: no es interpretable
  const at = rest.indexOf(APP_SEGMENT);
  if (at === -1) {
    // Sin la carpeta en la ruta: solo es «fuera del prefijo» si NADA en la URL la menciona (p. ej. una capa `l_ai-wardrobe:…`).
    return evidence(partsOf(url, url.href)) ? null : { kind: "own", publicIds: [], delivery, insidePrefix: false };
  }
  if (rest.indexOf(APP_SEGMENT, at + 1) !== -1) return null; // carpeta repetida: id incierto
  const before = rest.slice(0, at);
  if (!before.every((s) => !s.includes(APP_SEGMENT) && (SIGNATURE.test(s) || VERSION.test(s) || isTransformation(s)))) return null;
  const idSegs = rest.slice(at);
  if (idSegs.length < 2 || idSegs.some((s) => s === "")) return null;
  if (query.some(([k, v]) => k.includes(APP_SEGMENT) || v.includes(APP_SEGMENT)) || mentionsIn(url) !== 1) return null;
  return { kind: "own", publicIds: candidates(idSegs.join("/")), delivery, insidePrefix: true };
}

function parseOwnDownload(segs: string[], url: URL): ImageUrlRef | null {
  if (segs.length !== 4 || segs[2] !== "image" || segs[3] !== "download") return null;
  const query = strictQuery(url);
  if (query === null) return null;
  const ids = query.filter(([k]) => k === "public_id").map(([, v]) => v);
  const types = query.filter(([k]) => k === "type").map(([, v]) => v);
  if (ids.length !== 1 || !ids[0] || types.length > 1 || strict(url.hash.slice(1)) === null) return null;
  const id = ids[0];
  if (query.some(([k, v]) => k !== "public_id" && (k.includes(APP_SEGMENT) || v.includes(APP_SEGMENT)))) return null;
  const delivery = types[0] ?? null;
  if (!id.startsWith(`${APP_SEGMENT}/`)) {
    return evidence(partsOf(url, url.href)) ? null : { kind: "own", publicIds: [], delivery, insidePrefix: false };
  }
  const idSegs = id.split("/");
  if (idSegs.length < 2 || idSegs.some((s) => s === "") || idSegs.indexOf(APP_SEGMENT, 1) !== -1) return null;
  if (mentionsIn(url) !== 1) return null; // la única mención permitida es la del propio public_id
  return { kind: "own", publicIds: [id], delivery, insidePrefix: true };
}

export function parseImageUrl(raw: unknown, cloudName: string): ImageUrlRef {
  if (typeof raw !== "string" || raw.trim() === "") return EXTERNAL;
  let url: URL | null = null;
  try { url = new URL(raw.trim()); } catch { /* no es una URL: solo cuentan sus indicios */ }
  /** Ambigua con los propietarios que se puedan leer; global si es de nuestra cuenta y no se puede acotar. */
  const ambiguous = (ours: boolean): ImageUrlRef => evidence(partsOf(url, raw)) ?? (ours ? { kind: "ambiguous", ownerIds: null } : EXTERNAL);

  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return ambiguous(false);
  const host = url.hostname;
  const isRes = RES_HOST.test(host);
  if (!isRes && host !== API_HOST) return ambiguous(false); // CDN, proxy u otro dominio: solo cuenta lo que mencione

  const raws = url.pathname.split("/").slice(1);
  const segs = raws.map(strict);
  const cloudSeg = isRes ? segs[0] : segs[1];
  if (!isRes && segs[0] !== "v1_1") return ambiguous(false);
  if (cloudSeg === null || cloudSeg === undefined) return ambiguous(true); // no se puede saber de qué cuenta es
  if (cloudSeg.toLowerCase() !== cloudName.toLowerCase()) return EXTERNAL; // otra cuenta de Cloudinary: nunca es nuestra
  if (cloudSeg !== cloudName || segs.some((s) => s === null)) return ambiguous(true);
  const exact = isRes ? parseOwnRes(segs as string[], url) : parseOwnDownload(segs as string[], url);
  return exact ?? ambiguous(true);
}
