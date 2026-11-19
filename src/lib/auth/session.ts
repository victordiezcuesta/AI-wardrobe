import { cache } from "react";
import { getToken } from "next-auth/jwt";
import { env } from "@/lib/env";
import { unauthorized } from "@/lib/errors";
import { sessionService } from "@/services/session.service";
import { auth } from "./index";

/**
 * Devuelve el id del usuario autenticado o lanza 401. Úsalo en todo Route Handler privado.
 * `auth()` ya valida la sesión individual en Neon (callback `jwt` de ./index): si se cerró, se revocó al cambiar la
 * contraseña o caducó, devuelve null. Como la fila `Session` depende del usuario con borrado en cascada, una sesión
 * válida implica que la cuenta existe, así que no hace falta otra consulta.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw unauthorized();
  return id;
}

/**
 * Sesión para Server Components (páginas y layouts). `cache()` comparte el resultado entre el layout y la página de
 * una misma petición, para no validar la sesión en Neon dos veces. No usar en Route Handlers (fuera del render
 * de React `cache()` no memoriza): allí, `requireUserId()`.
 */
export const currentSession = cache(() => auth());

/** Nombres de la cookie de sesión de Auth.js (con HTTPS lleva el prefijo __Secure-); el JWT se cifra con ese nombre como sal. */
const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"];

/**
 * Revoca en Neon la sesión del JWT de esta petición (logout de un solo dispositivo). Lanza si la base de datos falla,
 * para que el cliente no dé el logout por completado. Sin cookie o con un JWT ilegible no hay nada que revocar.
 */
export async function revokeCurrentSession(req: Request): Promise<void> {
  for (const cookieName of SESSION_COOKIES) {
    const token = await getToken({ req, secret: env().AUTH_SECRET, cookieName, secureCookie: cookieName.startsWith("__Secure-") });
    if (token) { await sessionService.revoke(token.sid); return; }
  }
}
