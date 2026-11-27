import { NextResponse } from "next/server";
import { ZodError } from "zod";
import "@/lib/validations/messages"; // mensajes de validación en español en la instancia de Zod que cargan las rutas (todas usan handler)
import { safeDbError } from "./db";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "BAD_REQUEST",
  ) {
    super(message);
  }
}
export const unauthorized = () => new AppError("No autenticado", 401, "UNAUTHORIZED");
export const forbidden = () => new AppError("Sin permiso", 403, "FORBIDDEN");
export const notFound = (what = "Recurso") => new AppError(`${what} no encontrado`, 404, "NOT_FOUND");
export const tooMany = (retryAfterSec: number) =>
  new AppError(`Demasiadas solicitudes. Inténtalo en ${retryAfterSec}s`, 429, "RATE_LIMITED");

export function logError(scope: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(JSON.stringify({ level: "error", scope, message: e.message, stack: e.stack?.split("\n").slice(0, 4) }));
}

/** Convierte cualquier error en una respuesta JSON uniforme. */
export function toResponse(scope: string, err: unknown) {
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: "Datos no válidos", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } },
      { status: 422 },
    );
  }
  // Errores de base de datos: solo su código (Prisma puede repetir en el mensaje argumentos de la consulta, como ids o
  // publicId). El resto se registra completo. La respuesta al cliente no cambia.
  logError(scope, safeDbError(err));
  return NextResponse.json({ error: { code: "INTERNAL", message: "Error interno" } }, { status: 500 });
}

/**
 * Defensa CSRF para rutas que modifican datos: si el navegador declara un Origin, debe ser el propio sitio.
 * Se suma a las cookies SameSite=Lax de Auth.js. Los clientes sin Origin (curl, servidor a servidor) no llevan la cookie de sesión.
 */
export function assertSameOrigin(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try { originHost = new URL(origin).host; } catch { /* "null" u origen mal formado */ }
  if (!originHost || originHost !== host) throw new AppError("Origen no permitido", 403, "BAD_ORIGIN");
}

/** Envoltorio para Route Handlers: captura errores y aplica el formato común. */
export function handler<A extends unknown[]>(scope: string, fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      if (args[0] instanceof Request) assertSameOrigin(args[0]);
      return await fn(...args);
    } catch (err) {
      return toResponse(scope, err);
    }
  };
}
