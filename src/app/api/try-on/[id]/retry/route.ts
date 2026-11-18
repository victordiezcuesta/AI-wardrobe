import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { tryOnService } from "@/services/tryon.service";

export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler("tryon.retry", async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  await rateLimit(`tryon:${userId}`, 15, 3600);
  return NextResponse.json({ image: await tryOnService.retry(userId, (await params).id) }, { status: 202 });
});
