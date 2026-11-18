import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { registerSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const POST = handler("auth.register", async (req: Request) => {
  await rateLimit(`register:${clientIp(req)}`, 5, 3600);
  const input = registerSchema.parse(await req.json());
  await authService.register(input);
  return NextResponse.json({ ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." }, { status: 201 });
});
