import { AppError, logError, notFound } from "@/lib/errors";
import { safeDbError } from "@/lib/errors/db";
import { deletePrivateImages, signedUrl, uploadPrivate } from "@/lib/cloudinary";
import { prisma } from "@/lib/prisma";
import { MAX_PERSONAL_PHOTOS } from "@/features/virtual-try-on/constants";
import { consentService } from "./consent.service";

const folder = (userId: string) => `ai-wardrobe/${userId}/personal`;

/**
 * Tras un fallo al guardar una foto recién subida: ¿quedó referenciada? "own" → en el perfil del usuario (se guardó);
 * "other" → la usa otra fila (otro perfil o una generación): no se toca; "absent" → confirmado que nadie la usa (se
 * puede borrar); "unknown" → no se pudo consultar: no se borra a ciegas (se registra sin publicId ni userId).
 * Solo lee: la limpieza nunca escribe en la base de datos, así que no puede pisar una escritura concurrente.
 */
async function photoReference(userId: string, publicId: string): Promise<"own" | "other" | "absent" | "unknown"> {
  try {
    if ((await prisma.userProfile.count({ where: { userId, photoPublicIds: { has: publicId } } })) > 0) return "own";
    const [profiles, jobs] = await Promise.all([
      prisma.userProfile.count({ where: { photoPublicIds: { has: publicId } } }),
      prisma.generatedImage.count({ where: { sourcePhotoId: publicId } }),
    ]);
    return profiles + jobs > 0 ? "other" : "absent";
  } catch (e) {
    logError("photos.orphan_unverified", safeDbError(e));
    return "unknown";
  }
}

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
    // Alta atómica con el límite en la propia sentencia: dos subidas simultáneas no lo pueden rebasar.
    // El perfil existe siempre aquí (el consentimiento se guarda en él).
    let added: number;
    try {
      added = await prisma.$executeRaw`UPDATE "UserProfile" SET "photoPublicIds" = array_append("photoPublicIds", ${stored.publicId})
        WHERE "userId" = ${userId} AND cardinality("photoPublicIds") < ${MAX_PERSONAL_PHOTOS}`;
    } catch (err) {
      // La escritura falló o se perdió su respuesta: antes de tocar la foto se comprueba qué quedó guardado.
      const ref = await photoReference(userId, stored.publicId);
      if (ref === "own") return { publicId: stored.publicId, url: signedUrl(stored.publicId) }; // se guardó pese al error
      if (ref === "absent") await deletePrivateImages([stored.publicId]).catch((e) => logError("photos.orphan", e));
      throw safeDbError(err); // "other"/"unknown": la foto se conserva
    }
    if (added === 0) {
      // La sentencia se ejecutó y no añadió nada (límite alcanzado): la foto no tiene ninguna referencia.
      await deletePrivateImages([stored.publicId]).catch((e) => logError("photos.orphan", e));
      throw new AppError(`Máximo ${MAX_PERSONAL_PHOTOS} fotos personales`, 422, "PHOTO_LIMIT");
    }
    return { publicId: stored.publicId, url: signedUrl(stored.publicId) };
  },

  /**
   * Solo se puede borrar una foto que figure en la lista del propio usuario. Primero se borra en Cloudinary: si falla,
   * la referencia se conserva (el usuario la sigue viendo y puede reintentar) en lugar de dejar la foto privada huérfana.
   * La lista se actualiza con array_remove, sin leer-modificar-escribir que pudiera perder una subida simultánea.
   */
  async remove(userId: string, publicId: string) {
    if (!(await this.owns(userId, publicId))) throw notFound("Foto");
    await deletePrivateImages([publicId]);
    await prisma.$executeRaw`UPDATE "UserProfile" SET "photoPublicIds" = array_remove("photoPublicIds", ${publicId}) WHERE "userId" = ${userId}`;
  },

  owns: async (userId: string, publicId: string) =>
    !!(await prisma.userProfile.findUnique({ where: { userId }, select: { photoPublicIds: true } }))?.photoPublicIds.includes(publicId),
};
