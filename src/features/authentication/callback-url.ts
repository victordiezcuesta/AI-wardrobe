/** Destino tras el login cuando no hay `callbackUrl` o no es seguro. */
export const DEFAULT_AFTER_LOGIN = "/dashboard";

/** Páginas a las que no tiene sentido volver tras iniciar sesión (bucle) y rutas que no son páginas. */
const NOT_A_DESTINATION = ["/login", "/register", "/forgot-password", "/reset-password", "/verify-email", "/api/"];

/**
 * Convierte un `callbackUrl` NO confiable (viene de la query string) en una ruta interna segura para `router.push`,
 * o devuelve `/dashboard`. Acepta tanto rutas relativas (`/wardrobe?x=1`) como la URL absoluta que genera el proxy
 * de Auth.js (`http://host/wardrobe?x=1`), siempre que sea del mismo origen que la app.
 *
 * Nunca devuelve el valor recibido: devuelve `pathname + search + hash` de la URL ya analizada, de modo que lo que
 * llega a `router.push` es siempre una ruta que empieza por una sola `/`.
 */
export function safeCallbackPath(raw: string | null | undefined, appOrigin: string): string {
  if (!raw) return DEFAULT_AFTER_LOGIN;
  // Barras invertidas, espacios y caracteres de control: el analizador de URLs los normaliza o elimina
  // (p. ej. "/\evil.com" o "/\t/evil.com" acaban en http://evil.com/). Se rechazan antes de analizar.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_AFTER_LOGIN;

  let url: URL;
  let origin: string;
  try {
    origin = new URL(appOrigin).origin;
    url = new URL(raw, origin);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  // Mismo origen (protocolo + host + puerto) y solo http(s): descarta otros dominios, "//evil", "///evil",
  // "javascript:", "data:", "blob:"…
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) return DEFAULT_AFTER_LOGIN;
  if (url.username || url.password) return DEFAULT_AFTER_LOGIN;
  // Defensa en profundidad: la ruta resultante debe empezar por exactamente una "/".
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return DEFAULT_AFTER_LOGIN;
  if (NOT_A_DESTINATION.some((p) => url.pathname === p || url.pathname.startsWith(p.endsWith("/") ? p : `${p}/`))) {
    return DEFAULT_AFTER_LOGIN;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
