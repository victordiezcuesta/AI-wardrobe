import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { verifySchema } from "@/lib/validations/auth";
import { authService } from "@/services/auth.service";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const POST = handler("auth.verify", async (req: Request) => {
  await rateLimit(`verify:${clientIp(req)}`, 20, 3600);
  const { token } = verifySchema.parse(await req.json());
  await authService.verifyEmail(token);
  return NextResponse.json({ ok: true });
});
