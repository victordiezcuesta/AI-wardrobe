import { AppError } from "@/lib/errors";
import { assertAllowedUrl, resolvePublicAddresses } from "./remote-url";
import { requestPinned } from "./pinned-request";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // límite de cuerpo de las funciones de Vercel ≈ 4,5 MB

export type ImageKind = "jpeg" | "png" | "webp";

/** Detecta el formato por firma binaria; no se fía del Content-Type ni de la extensión. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export async function readImageFile(file: File): Promise<Buffer> {
  if (file.size === 0) throw new AppError("El archivo está vacío", 422, "INVALID_FILE");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("La imagen supera los 4 MB", 413, "FILE_TOO_LARGE");
  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(buf)) throw new AppError("Formato no admitido. Usa JPG, PNG o WebP", 415, "UNSUPPORTED_TYPE");
  return buf;
}

/** Margen para las cabeceras multipart de un único archivo. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** Tamaño máximo del cuerpo de una subida (imagen + cabeceras multipart). */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD;

/**
 * Rechazo temprano por cabecera: si el Content-Length declarado ya excede el límite, la subida se rechaza (413) antes de
 * leer el cuerpo. Solo se acepta una cabecera formada por dígitos: un valor manipulado (negativo, decimal, exponente,
 * texto o lista de valores como «100, 99999999») no puede esquivar la comparación y se rechaza (400).
 * Sin cabecera (chunked, HTTP/2…) no se rechaza aquí: el límite real del cuerpo lo aplica `readUploadForm` al leerlo.
 */
export function assertUploadSize(req: Request): void {
  const raw = req.headers.get("content-length");
  if (raw === null) return;
  const value = raw.trim();
  if (!/^\d{1,16}$/.test(value)) throw new AppError("La subida no es válida", 400, "INVALID_UPLOAD");
  if (Number(value) > MAX_UPLOAD_REQUEST_BYTES) throw new AppError("La imagen supera los 4 MB", 413, "FILE_TOO_LARGE");
}

/**
 * Lee el formulario multipart de una subida limitando el cuerpo recibido a `maxBytes`, haya o no Content-Length
 * (chunked, HTTP/2 o una cabecera que no cuadre con el cuerpo): el stream se lee contando bytes y, en cuanto supera el
 * límite, se cancela la lectura y se responde 413 sin consumir el resto. Solo después se interpreta el multipart sobre
 * esos bytes ya acotados. La memoria de la petición queda acotada en proporción a `maxBytes`, no exactamente a él: unir
 * los trozos y el parser multipart hacen copias adicionales. Un multipart mal formado es un 400, no un error interno.
 */
export async function readUploadForm(req: Request, maxBytes = MAX_UPLOAD_REQUEST_BYTES): Promise<FormData> {
  assertUploadSize(req); // rechazo inmediato si la cabecera ya lo delata
  if (!req.body) throw new AppError("Falta la imagen", 422, "INVALID_FILE");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined); // deja de leer: el resto del cuerpo no se consume
      throw new AppError("La imagen supera los 4 MB", 413, "FILE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const contentType = req.headers.get("content-type") ?? "";
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new AppError("La subida no es válida", 400, "INVALID_UPLOAD");
  }
}

export const MAX_IMAGE_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Descarta el cuerpo de una respuesta que no se va a leer (libera la conexión). */
const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

/**
 * Descarga una imagen en el servidor sin abrir la puerta a SSRF:
 * - la URL inicial y CADA redirección (máx. 3, seguidas a mano) se validan con `assertAllowedUrl` (HTTPS, sin
 *   credenciales ni puerto, host exacto de `allowedHosts`, nunca localhost/IP privada) ANTES de pedirlas; nada se
 *   descarga de un destino no validado;
 * - en cada salto el host se resuelve una vez (`resolvePublicAddresses`: todas sus IP deben ser públicas) y la conexión
 *   se fija a esas IP (`requestPinned`), sin segunda resolución DNS (DNS rebinding) y con TLS sobre el hostname original;
 * - un único timeout cubre DNS, redirecciones y lectura del cuerpo;
 * - el tamaño se corta en streaming (sin leerla entera) y el contenido debe tener firma JPEG, PNG o WebP.
 * Los errores no se muestran al usuario: van al log del llamador.
 */
export async function fetchImage(
  url: string,
  opts: { allowedHosts: readonly string[]; maxBytes: number; timeoutMs: number },
): Promise<{ bytes: Buffer; mime: string }> {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = assertAllowedUrl(url, allowed);
  let res: Response;
  for (let redirects = 0; ; redirects++) {
    const addresses = await resolvePublicAddresses(current.hostname, signal);
    res = await requestPinned(current, addresses, { signal }); // no sigue redirecciones por su cuenta
    if (!REDIRECT_STATUSES.has(res.status)) break;
    await discard(res);
    if (redirects >= MAX_IMAGE_REDIRECTS) throw new Error("Demasiadas redirecciones");
    const location = res.headers.get("location");
    if (!location) throw new Error("Redirección sin destino");
    let next: URL;
    try { next = new URL(location, current); } catch { throw new Error("Redirección no válida"); }
    current = assertAllowedUrl(next, allowed);
  }
  // Solo 200: un 206 (contenido parcial) u otro 2xx no garantiza la imagen completa.
  if (res.status !== 200) { await discard(res); throw new Error(`No se pudo descargar la imagen (${res.status})`); }
  if (Number(res.headers.get("content-length")) > opts.maxBytes) { await discard(res); throw new Error("Imagen demasiado grande"); }
  if (!res.body) throw new Error("Respuesta sin cuerpo");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // El timeout corta también la lectura del cuerpo, aunque el stream no atienda a la señal por su cuenta.
  const onAbort = () => { reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted(); // un cuerpo cortado por el timeout nunca se da por completo
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("Imagen demasiado grande"); }
      chunks.push(value);
    }
  } catch (err) {
    throw signal.aborted ? signal.reason : err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = Buffer.concat(chunks);
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("El contenido descargado no es una imagen válida");
  return { bytes, mime: `image/${kind}` };
}
