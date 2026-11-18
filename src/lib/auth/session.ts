import { prisma } from "@/lib/prisma";
import { unauthorized } from "@/lib/errors";
import { auth } from "./index";

/**
 * Devuelve el id del usuario autenticado o lanza 401. Úsalo en todo Route Handler privado.
 * Comprueba también que la cuenta sigue existiendo: un JWT emitido antes de eliminar la cuenta
 * (p. ej. en otro dispositivo) no debe seguir dando acceso.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw unauthorized();
  const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw unauthorized();
  return id;
}
