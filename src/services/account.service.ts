import bcrypt from "bcryptjs";
import { AppError, logError, notFound } from "@/lib/errors";
import { deleteAllUserAssets } from "@/lib/cloudinary";
import { prisma } from "@/lib/prisma";
import { userRepository } from "@/repositories/user.repository";
import { sessionService } from "@/services/session.service";

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
   * Cambio de contraseña con la sesión abierta (20.3b). Conserva la sesión `sid` y revoca las demás del usuario.
   * El hash nuevo se genera FUERA de la transacción (bcrypt no mantiene una transacción abierta). La actualización es un
   * compare-and-set sobre el hash leído y la revocación va en la MISMA transacción: si el hash cambió entretenidamente
   * (otro cambio o un restablecimiento) → 409 CONFLICT sin tocar nada; si la revocación falla, el hash tampoco cambia.
   */
  async changePassword(userId: string, sid: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user) throw notFound("Cuenta");
    const currentHash = user.passwordHash;
    if (!currentHash) throw new AppError("Tu cuenta no tiene contraseña local", 409, "NO_LOCAL_PASSWORD");
    if (!(await bcrypt.compare(currentPassword, currentHash))) throw new AppError("La contraseña actual no es correcta", 403, "BAD_PASSWORD");
    if (newPassword === currentPassword) throw new AppError("La contraseña nueva debe ser distinta de la actual", 422, "SAME_PASSWORD");
    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.$transaction(async (tx) => {
      if ((await userRepository.setPasswordIfUnchanged(userId, currentHash, newHash, tx)) !== 1) {
        throw new AppError("Tu contraseña ha cambiado mientras tanto. Vuelve a intentarlo.", 409, "CONFLICT");
      }
      await sessionService.revokeOthers(userId, sid, tx);
    });
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
      // PRIMERO se bloquea la fila del usuario (orden de bloqueos User → MediaAsset, el mismo que la persistencia de la
      // reconciliación, que toma FOR KEY SHARE de los propietarios antes de tocar MediaAsset): sin interbloqueos, y una
      // persistencia en curso termina antes de que el borrado lea MediaAsset (sus filas nuevas también se eliminan).
      prisma.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
      prisma.verificationToken.deleteMany({ where: { identifier: user.email } }),
      prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "key" LIKE ${`%:${userId}`}`,
      // Reconciliación de medios: MediaAsset no tiene FK a User (debe poder sobrevivir a la cuenta mientras el
      // reconciliador la necesite), así que no hay cascada. Sus imágenes ya se borraron arriba en Cloudinary: se eliminan
      // aquí, en la MISMA transacción que la cuenta (o todo o nada). Las ejecuciones y el lock no son del usuario.
      prisma.mediaAsset.deleteMany({ where: { ownerUserId: userId } }),
      // deleteMany (no delete): idempotente. Con dos borrados simultáneos de la misma cuenta, el segundo no encuentra la fila (la
      // primera ya la eliminó) y `delete` lanzaría P2025 (500); así termina sin error y la cuenta queda borrada igualmente.
      prisma.user.deleteMany({ where: { id: userId } }), // cascada: perfil, armario, conjuntos, imágenes, compras, preferencias, registros de IA…
    ]);
  },
};
