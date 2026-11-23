import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { resetSchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { rateLimitByIp } from "@/lib/rate-limit/ip";

export const POST = handler("auth.reset", async (req: Request) => {
  await rateLimitByIp(req, "reset", 10, 3600);
  const { token, password } = resetSchema.parse(await req.json());
  await authService.resetPassword(token, password);
  return NextResponse.json({ ok: true });
});
