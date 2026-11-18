import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { recommendBodySchema } from "@/lib/validations/shopping";
import { shoppingService } from "@/services/shopping.service";

export const maxDuration = 60;

export const GET = handler("shopping.latest", async () => NextResponse.json({ batch: await shoppingService.latest(await requireUserId()) }));

export const POST = handler("shopping.recommend", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`shopping:${userId}`, 10, 3600);
  const body = recommendBodySchema.parse(await req.json().catch(() => ({})));
  return NextResponse.json({ batch: await shoppingService.recommend(userId, { force: body.force }) });
});
