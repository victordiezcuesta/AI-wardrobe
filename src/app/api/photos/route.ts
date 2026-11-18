import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { readImageFile } from "@/lib/uploads/validate";
import { photoService } from "@/services/photo.service";

export const GET = handler("photos.list", async () => NextResponse.json({ photos: await photoService.list(await requireUserId()) }));

export const POST = handler("photos.add", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`photos:${userId}`, 20, 3600);
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) throw new AppError("Falta la imagen", 422, "INVALID_FILE");
  const buffer = await readImageFile(file);
  return NextResponse.json({ photo: await photoService.add(userId, buffer) }, { status: 201 });
});

export const DELETE = handler("photos.delete", async (req: Request) => {
  const userId = await requireUserId();
  const { publicId } = z.object({ publicId: z.string().min(1).max(200) }).parse(Object.fromEntries(new URL(req.url).searchParams));
  await photoService.remove(userId, publicId);
  return NextResponse.json({ ok: true });
});
