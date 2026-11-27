import { after, NextResponse } from "next/server";
import { handler, logError } from "@/lib/errors";
import { safeDbError } from "@/lib/errors/db";
import { forgotSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { rateLimitByIp } from "@/lib/rate-limit/ip";
import { rateLimitByEmail } from "@/lib/rate-limit/email";

/**
 * `after()` ejecuta la consulta de usuario, el token y el envío tras responder, dentro de este límite. El envío SMTP está acotado a 20 s
 * (`SEND_DEADLINE_MS` en lib/mail); los 10 s restantes cubren la consulta y el token. Sin `maxDuration` explícito, la plataforma aplicaría
 * el suyo por defecto y podría cortar el trabajo diferido sin dejar rastro.
 */
export const maxDuration = 30;

export const POST = handler("auth.forgot", async (req: Request) => {
  await rateLimitByIp(req, "forgot", 5, 3600);
  const { email } = forgotSchema.parse(await req.json());
  // Por email (ya validado y normalizado), exista o no la cuenta: no se consulta nada antes de contar.
  await rateLimitByEmail("forgot-email", email, 3, 3600);
  // Nada que dependa de si la cuenta existe (consulta, token, correo, fallos de SMTP) ocurre antes de responder: el camino síncrono
  // es el mismo para cuentas existentes e inexistentes. El callback captura todo: no puede cambiar la respuesta ni dejar promesas sueltas.
  after(async () => {
    try {
      await authService.requestReset(email);
    } catch (err) {
      logError("auth.forgot.deferred", safeDbError(err));
    }
  });
  return NextResponse.json({ ok: true, message: "Si la cuenta existe, recibirás un enlace." });
});
