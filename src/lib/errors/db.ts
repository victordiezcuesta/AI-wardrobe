/**
 * Errores de base de datos aptos para el log: Prisma puede repetir en su mensaje los argumentos de la consulta
 * (publicId de imágenes, id de usuario…), así que solo se conserva el código (P1001, P2024…).
 */
export function dbFailure(err: unknown): Error {
  const e = err as { code?: unknown; errorCode?: unknown } | null;
  const code = e?.code ?? e?.errorCode; // PrismaClientInitializationError lo guarda en errorCode
  return new Error(`Fallo de base de datos${typeof code === "string" && /^[A-Z0-9_]{1,16}$/.test(code) ? ` (${code})` : ""}`);
}

/**
 * ¿Es un error de Prisma o de su adaptador? Por nombre de clase (PrismaClientKnownRequestError, …ValidationError —que no
 * tiene code y es la que más repite argumentos—, DriverAdapterError…) o por código Pxxxx, sin depender de instanceof.
 */
export function isDbError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null;
  return (typeof e?.name === "string" && /^(PrismaClient\w*Error|DriverAdapterError)$/.test(e.name))
    || (typeof e?.code === "string" && /^P\d{4}$/.test(e.code));
}

/** Lo que se relanza o registra: los errores de base de datos, saneados; el resto, intactos (conservan su diagnóstico). */
export const safeDbError = (err: unknown): unknown => (isDbError(err) ? dbFailure(err) : err);

/** Lee una propiedad sin que un objeto manipulado (getter que lanza, `Proxy`) pueda provocar una excepción. */
function safeRead(obj: unknown, key: string): unknown {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return undefined;
  try { return (obj as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** Restricción única que se busca: tabla y, según el adaptador, sus columnas (Neon) o el nombre de su índice (pg). */
export interface UniqueConstraintRef { table: string; fields: readonly string[]; index: string }

/**
 * ¿Es este error una violación de UNA restricción única concreta? Con adaptadores de driver (Prisma 7) un P2002 no trae `meta.target`:
 * trae `meta.driverAdapterError.cause = { kind: "UniqueConstraintViolation", constraint, table }`, donde `constraint` es
 * `{ fields: [...] }` (adaptador de Neon, producción) o `{ index: "<nombre>" }` (adaptador pg, pruebas). Se acepta SOLO si el código es
 * P2002, el tipo es `UniqueConstraintViolation` y la restricción coincide EXACTAMENTE (índice igual, o columnas iguales y en el mismo
 * orden) y, si el error informa de la tabla, es la esperada. Nunca se interpretan mensajes. Si falta cualquier dato (p. ej. un servidor
 * con mensajes localizados, donde Neon no puede extraer `fields`) devuelve `false`: ante la duda el error NO se oculta.
 */
export function isUniqueViolationOn(err: unknown, ref: UniqueConstraintRef): boolean {
  let isDb = false;
  try { isDb = isDbError(err); } catch { return false; } // `isDbError` lee propiedades sin protección: un objeto hostil no debe hacerlo lanzar
  if (!isDb || safeRead(err, "code") !== "P2002") return false;
  const cause = safeRead(safeRead(safeRead(err, "meta"), "driverAdapterError"), "cause");
  if (safeRead(cause, "kind") !== "UniqueConstraintViolation") return false;
  const table = safeRead(cause, "table");
  if (table !== undefined && table !== ref.table) return false;
  const constraint = safeRead(cause, "constraint");
  const index = safeRead(constraint, "index");
  if (typeof index === "string") return index === ref.index;
  const fields = safeRead(constraint, "fields");
  return Array.isArray(fields) && fields.length === ref.fields.length && fields.every((f, i) => f === ref.fields[i]);
}
