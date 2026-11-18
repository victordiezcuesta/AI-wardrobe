import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { createItemSchema, listQuerySchema } from "@/lib/validations/wardrobe";
import { wardrobeService } from "@/services/wardrobe.service";
import { rateLimit } from "@/lib/rate-limit";

export const GET = handler("wardrobe.list", async (req: Request) => {
  const userId = await requireUserId();
  const query = listQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  return NextResponse.json(await wardrobeService.list(userId, query));
});

/** Alta manual de una prenda (sin foto; la foto se puede añadir al subirla con el analizador). */
export const POST = handler("wardrobe.create", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`wardrobe:create:${userId}`, 120, 3600);
  const input = createItemSchema.parse(await req.json());
  return NextResponse.json({ item: await wardrobeService.create(userId, input) }, { status: 201 });
});
