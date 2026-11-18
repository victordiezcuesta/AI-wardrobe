import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { stylistRequestSchema } from "@/lib/validations/stylist";
import { stylistService } from "@/services/stylist.service";
import { outfitService } from "@/services/outfit.service";

export const maxDuration = 60;

export const POST = handler("stylist.generate", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`stylist:${userId}`, 20, 3600);
  const input = stylistRequestSchema.parse(await req.json());
  const result = await stylistService.generate(userId, input);
  return NextResponse.json({ ...result, alternativeItems: await outfitService.alternativeItems(userId, result.outfits) });
});
