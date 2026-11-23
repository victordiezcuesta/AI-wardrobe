import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { updateItemSchema } from "@/lib/validations/wardrobe";
import { wardrobeService } from "@/services/wardrobe.service";
import { rateLimit } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler("wardrobe.get", async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  return NextResponse.json({ item: await wardrobeService.get(userId, (await params).id) });
});

export const PATCH = handler("wardrobe.update", async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  await rateLimit(`wardrobe:update:${userId}`, 300, 3600);
  const input = updateItemSchema.parse(await req.json());
  return NextResponse.json({ item: await wardrobeService.update(userId, (await params).id, input) });
});

export const DELETE = handler("wardrobe.delete", async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  await rateLimit(`wardrobe:delete:${userId}`, 120, 3600); // antes de cualquier acceso a datos o a Cloudinary
  await wardrobeService.remove(userId, (await params).id);
  return NextResponse.json({ ok: true });
});
