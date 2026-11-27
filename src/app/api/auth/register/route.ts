import { after, NextResponse } from "next/server";
import { handler, logError } from "@/lib/errors";
import { safeDbError } from "@/lib/errors/db";
import { registerSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { rateLimitByIp } from "@/lib/rate-limit/ip";
import { rateLimitByEmail } from "@/lib/rate-limit/email";

/**
 * `after()` ejecuta tras responder la consulta de usuario, bcrypt (coste 12: del orden de 0,3–0,7 s en JS puro), la creación, el token y el
 * envío. El envío SMTP tiene un plazo de 20 s (`SEND_DEADLINE_MS` en lib/mail) y el resto del presupuesto, hasta 30 s, es para bcrypt y
 * las consultas. Sin `maxDuration` explícito la plataforma aplicaría el suyo y podría cortar el trabajo diferido sin dejar rastro.
 */
export const maxDuration = 30;

export const POST = handler("auth.register", async (req: Request) => {
  await rateLimitByIp(req, "register", 5, 3600);
  const input = registerSchema.parse(await req.json());
  // Por email (ya validado y normalizado), exista o no la cuenta: no se consulta nada antes de contar.
  await rateLimitByEmail("register-email", input.email, 3, 3600);
  // Nada que dependa de la cuenta (consulta, bcrypt, creación, token, correo, fallos de SMTP o de base de datos) ocurre antes de responder:
  // el camino síncrono es el mismo para una cuenta nueva, una verificada, una sin verificar o un envío que falla. El callback captura todo:
  // no puede cambiar la respuesta ni dejar promesas sueltas, y registra los errores sin la contraseña ni el email.
  after(async () => {
    try {
      await authService.register(input);
    } catch (err) {
      logError("auth.register.deferred", safeDbError(err));
    }
  });
  return NextResponse.json({ ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." }, { status: 201 });
});
