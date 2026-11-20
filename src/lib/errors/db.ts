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
