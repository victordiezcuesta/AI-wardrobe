import { NextResponse } from "next/server";
import { handler, unauthorized } from "@/lib/errors";
import { currentSessionId, requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { changePasswordSchema } from "@/lib/validations/auth";
import { accountService } from "@/services/account.service";

/**
 * Cambio de contraseña con la sesión abierta. Orden: autenticación → límite por usuario (cuenta CUALQUIER intento, también
 * los 422 y las contraseñas incorrectas) → validación → `sid` de la sesión actual (401 si no se recupera) → servicio.
 */
export const POST = handler("account.password", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`account-password:${userId}`, 5, 3600);
  const { currentPassword, newPassword } = changePasswordSchema.parse(await req.json());
  const sid = await currentSessionId(req, userId);
  if (!sid) throw unauthorized();
  await accountService.changePassword(userId, sid, currentPassword, newPassword);
  return NextResponse.json({ ok: true });
});
