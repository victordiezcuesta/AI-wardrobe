export class ApiError extends Error {
  constructor(message: string, public status: number, public issues?: { path: string; message: string }[], public code?: string) {
    super(message);
  }
}

/** Mensaje para un 401: la sesión no existe, caducó o se cerró (p. ej. desde otro dispositivo). */
export const SESSION_EXPIRED_MESSAGE = "Tu sesión ha caducado o se ha cerrado. Vuelve a iniciar sesión.";

const NOT_JSON = Symbol("not-json");

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => NOT_JSON);
  const error = data !== NOT_JSON ? (data as { error?: { code?: string; message?: string; issues?: { path: string; message: string }[] } })?.error : undefined;
  if (res.status === 401) throw new ApiError(SESSION_EXPIRED_MESSAGE, 401, undefined, error?.code ?? "UNAUTHORIZED");
  if (!res.ok) throw new ApiError(error?.message ?? "Error inesperado", res.status, error?.issues, error?.code);
  // Toda respuesta correcta de la API es JSON. Si no lo es (p. ej. una redirección seguida hasta una página HTML),
  // es un error: antes se devolvía {} como si la petición hubiera funcionado.
  if (data === NOT_JSON) throw new ApiError("Respuesta inesperada del servidor", res.status, undefined, "INVALID_RESPONSE");
  return data as T;
}
