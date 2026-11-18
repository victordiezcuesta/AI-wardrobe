import { AppError, logError, notFound } from "@/lib/errors";
import { deletePrivateImages, signedUrl, uploadPrivate } from "@/lib/cloudinary";
import { prisma } from "@/lib/prisma";
import { MAX_PERSONAL_PHOTOS } from "@/features/virtual-try-on/constants";
import { consentService } from "./consent.service";

const folder = (userId: string) => `ai-wardrobe/${userId}/personal`;

export const photoService = {
  async list(userId: string) {
    const p = await prisma.userProfile.findUnique({ where: { userId }, select: { photoPublicIds: true } });
    return (p?.photoPublicIds ?? []).map((publicId) => ({ publicId, url: signedUrl(publicId, { expiresInSec: 3600 }) }));
  },

  async add(userId: string, buffer: Buffer) {
    await consentService.require(userId); // sin consentimiento no se sube ni se guarda nada
    const p = await prisma.userProfile.findUnique({ where: { userId }, select: { photoPublicIds: true } });
    if ((p?.photoPublicIds.length ?? 0) >= MAX_PERSONAL_PHOTOS) throw new AppError(`Máximo ${MAX_PERSONAL_PHOTOS} fotos personales`, 422, "PHOTO_LIMIT");
    const stored = await uploadPrivate(buffer, folder(userId), { maxSide: 1600 });
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, photoPublicIds: [stored.publicId] },
      update: { photoPublicIds: { push: stored.publicId } },
    });
    return { publicId: stored.publicId, url: signedUrl(stored.publicId) };
  },

  /** Solo se puede borrar una foto que figure en la lista del propio usuario. */
  async remove(userId: string, publicId: string) {
    const p = await prisma.userProfile.findUnique({ where: { userId }, select: { photoPublicIds: true } });
    if (!p?.photoPublicIds.includes(publicId)) throw notFound("Foto");
    await prisma.userProfile.update({ where: { userId }, data: { photoPublicIds: p.photoPublicIds.filter((x) => x !== publicId) } });
    await deletePrivateImages([publicId]).catch((e) => logError("photos.delete", e));
  },

  owns: async (userId: string, publicId: string) =>
    !!(await prisma.userProfile.findUnique({ where: { userId }, select: { photoPublicIds: true } }))?.photoPublicIds.includes(publicId),
};
