import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { accountService } from "@/services/account.service";

export const maxDuration = 60;

export const DELETE = handler("account.delete", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`account-delete:${userId}`, 5, 3600);
  const { password } = z.object({ password: z.string().max(128).default("") }).parse(await req.json());
  await accountService.delete(userId, password);
  return NextResponse.json({ ok: true });
});
