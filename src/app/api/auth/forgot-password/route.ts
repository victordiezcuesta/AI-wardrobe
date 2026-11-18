import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { forgotSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const POST = handler("auth.forgot", async (req: Request) => {
  await rateLimit(`forgot:${clientIp(req)}`, 5, 3600);
  const { email } = forgotSchema.parse(await req.json());
  await authService.requestReset(email);
  return NextResponse.json({ ok: true, message: "Si la cuenta existe, recibirás un enlace." });
});
