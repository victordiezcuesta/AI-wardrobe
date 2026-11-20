import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { readImageFile, readUploadForm } from "@/lib/uploads/validate";
import { wardrobeService } from "@/services/wardrobe.service";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;
const modeSchema = z.enum(["single", "multi"]).default("single");

/** Una foto por petición: el cliente las envía de una en una para no pasar el límite de tiempo de la función. */
export const POST = handler("wardrobe.analyze", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`wardrobe:upload:${userId}`, 120, 3600);
  const form = await readUploadForm(req); // cuerpo leído con límite estricto, haya o no Content-Length
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("Falta la imagen", 422, "INVALID_FILE");
  const mode = modeSchema.parse(form.get("mode") ?? undefined);
  const buffer = await readImageFile(file);
  return NextResponse.json(await wardrobeService.createFromUpload(userId, buffer, mode));
});
