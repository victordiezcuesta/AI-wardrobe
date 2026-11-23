import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { forgotSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { rateLimitByIp } from "@/lib/rate-limit/ip";
import { rateLimitByEmail } from "@/lib/rate-limit/email";

export const POST = handler("auth.forgot", async (req: Request) => {
  await rateLimitByIp(req, "forgot", 5, 3600);
  const { email } = forgotSchema.parse(await req.json());
  // Por email (ya validado y normalizado), exista o no la cuenta: no se consulta nada antes de contar.
  await rateLimitByEmail("forgot-email", email, 3, 3600);
  await authService.requestReset(email);
  return NextResponse.json({ ok: true, message: "Si la cuenta existe, recibirás un enlace." });
});
