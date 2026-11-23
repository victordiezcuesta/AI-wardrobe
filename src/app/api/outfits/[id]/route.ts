import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { outfitPatchSchema } from "@/lib/validations/stylist";
import { outfitService } from "@/services/outfit.service";
import { rateLimit } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler("outfits.get", async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const outfit = await outfitService.get(userId, (await params).id);
  return NextResponse.json({ outfit, alternativeItems: await outfitService.alternativeItems(userId, [outfit]) });
});

export const PATCH = handler("outfits.patch", async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  await rateLimit(`outfit:favorite:${userId}`, 300, 3600);
  const { isFavorite } = outfitPatchSchema.parse(await req.json());
  const outfit = await outfitService.setFavorite(userId, (await params).id, isFavorite);
  return NextResponse.json({ outfit, alternativeItems: await outfitService.alternativeItems(userId, [outfit]) });
});
