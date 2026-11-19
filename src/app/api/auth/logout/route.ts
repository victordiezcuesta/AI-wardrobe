import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { revokeCurrentSession } from "@/lib/auth/session";

/**
 * Paso 1 del logout: revoca en Neon la sesión de este dispositivo. Solo si responde 200, el cliente llama a
 * `signOut()` de Auth.js para borrar la cookie. Si la base de datos falla responde 500 y la sesión no se da por cerrada.
 * (Ruta estática: tiene prioridad sobre /api/auth/[...nextauth].)
 */
export const POST = handler("auth.logout", async (req: Request) => {
  await revokeCurrentSession(req);
  return NextResponse.json({ ok: true });
});
