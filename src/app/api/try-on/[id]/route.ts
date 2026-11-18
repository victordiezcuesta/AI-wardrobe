import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { tryOnPatchSchema } from "@/lib/validations/tryon";
import { tryOnService } from "@/services/tryon.service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler("tryon.get", async (_req: Request, { params }: Ctx) =>
  NextResponse.json({ image: await tryOnService.get(await requireUserId(), (await params).id) }));

export const PATCH = handler("tryon.patch", async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { isFavorite } = tryOnPatchSchema.parse(await req.json());
  return NextResponse.json({ image: await tryOnService.setFavorite(userId, (await params).id, isFavorite) });
});

export const DELETE = handler("tryon.delete", async (_req: Request, { params }: Ctx) => {
  await tryOnService.remove(await requireUserId(), (await params).id);
  return NextResponse.json({ ok: true });
});
