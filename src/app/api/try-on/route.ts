import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { createTryOnSchema, tryOnListSchema } from "@/lib/validations/tryon";
import { tryOnService } from "@/services/tryon.service";

// La generación continúa tras responder (after); este tope aplica a esa ejecución en segundo plano.
export const maxDuration = 300;

export const GET = handler("tryon.list", async (req: Request) => {
  const userId = await requireUserId();
  const q = tryOnListSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  return NextResponse.json(await tryOnService.list(userId, { cursor: q.cursor, favorites: q.favorites === "true" }));
});

export const POST = handler("tryon.create", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`tryon:${userId}`, 15, 3600);
  const input = createTryOnSchema.parse(await req.json());
  return NextResponse.json({ image: await tryOnService.create(userId, input) }, { status: 202 });
});
