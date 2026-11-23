import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { registerSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { rateLimitByIp } from "@/lib/rate-limit/ip";
import { rateLimitByEmail } from "@/lib/rate-limit/email";

export const POST = handler("auth.register", async (req: Request) => {
  await rateLimitByIp(req, "register", 5, 3600);
  const input = registerSchema.parse(await req.json());
  // Por email (ya validado y normalizado), exista o no la cuenta: no se consulta nada antes de contar.
  await rateLimitByEmail("register-email", input.email, 3, 3600);
  await authService.register(input);
  return NextResponse.json({ ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." }, { status: 201 });
});
