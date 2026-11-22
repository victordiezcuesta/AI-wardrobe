import bcrypt from "bcryptjs";
import { AppError, logError, notFound } from "@/lib/errors";
import { deleteAllUserAssets } from "@/lib/cloudinary";
import { prisma } from "@/lib/prisma";

export const accountService = {
  /** Portabilidad de datos (RGPD art. 20): todo lo que tenemos del usuario, en JSON, sin hash de contraseña ni tokens. */
  async export(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, emailVerified: true, createdAt: true,
        profile: true,
        preferences: { select: { dimension: true, key: true, score: true } },
        items: true,
        outfits: { include: { items: { select: { itemId: true, alternatives: true } }, feedback: { select: { type: true, rating: true, note: true, createdAt: true } } } },
        history: { select: { outfitId: true, wornAt: true } },
        generated: { select: { id: true, outfitId: true, scenario: true, pose: true, status: true, isFavorite: true, createdAt: true } },
        shopping: { include: { products: true } },
        aiLogs: { select: { task: true, provider: true, model: true, inputTokens: true, outputTokens: true, success: true, createdAt: true } },
      },
    });
    if (!user) throw notFound("Cuenta");
    return { exportedAt: new Date().toISOString(), note: "Las imágenes se almacenan en Cloudinary y no se incluyen en este archivo; descárgalas desde la app antes de eliminar la cuenta.", ...user };
  },

  /**
   * Eliminación definitiva: exige la contraseña, borra primero las imágenes en Cloudinary y, solo si eso
   * ha ido bien, la cuenta (el resto se elimina en cascada). Si Cloudinary falla no se borra nada, para no dejar
   * fotos personales sin propietario; el usuario puede reintentar.
   */
  async delete(userId: string, password: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, passwordHash: true } });
    if (!user) throw notFound("Cuenta");
    if (user.passwordHash) {
      if (!(await bcrypt.compare(password, user.passwordHash))) throw new AppError("La contraseña no es correcta", 403, "BAD_PASSWORD");
    }
    try {
      await deleteAllUserAssets(userId);
    } catch (e) {
      logError("account.cloudinary", e);
      throw new AppError("No hemos podido borrar tus imágenes, así que no se ha eliminado la cuenta. Inténtalo de nuevo en unos minutos.", 502, "ASSET_DELETE_FAILED");
    }
    await prisma.$transaction([
      prisma.verificationToken.deleteMany({ where: { identifier: user.email } }),
      prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "key" LIKE ${`%:${userId}`}`,
      // Reconciliación de medios: MediaAsset no tiene FK a User (debe poder sobrevivir a la cuenta mientras el
      // reconciliador la necesite), así que no hay cascada. Sus imágenes ya se borraron arriba en Cloudinary: se eliminan
      // aquí, en la MISMA transacción que la cuenta (o todo o nada). Las ejecuciones y el lock no son del usuario.
      prisma.mediaAsset.deleteMany({ where: { ownerUserId: userId } }),
      prisma.user.delete({ where: { id: userId } }), // cascada: perfil, armario, conjuntos, imágenes, compras, preferencias, registros de IA…
    ]);
  },
};
