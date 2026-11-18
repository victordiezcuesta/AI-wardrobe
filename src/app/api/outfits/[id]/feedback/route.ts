import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { feedbackSchema } from "@/lib/validations/stylist";
import { outfitService } from "@/services/outfit.service";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler("outfits.feedback", async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  await rateLimit(`feedback:${userId}`, 200, 3600);
  const { type, rating } = feedbackSchema.parse(await req.json());
  const outfit = await outfitService.feedback(userId, (await params).id, type, rating);
  return NextResponse.json({ outfit, alternativeItems: await outfitService.alternativeItems(userId, [outfit]) });
});
