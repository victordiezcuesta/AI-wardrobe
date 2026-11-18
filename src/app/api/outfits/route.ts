import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { outfitListSchema } from "@/lib/validations/stylist";
import { outfitService } from "@/services/outfit.service";

export const GET = handler("outfits.list", async (req: Request) => {
  const userId = await requireUserId();
  const q = outfitListSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const res = await outfitService.list(userId, q.scope, q.cursor);
  return NextResponse.json({ ...res, alternativeItems: await outfitService.alternativeItems(userId, res.outfits) });
});
