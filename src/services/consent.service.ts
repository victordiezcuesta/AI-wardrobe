import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/** Versión del texto de consentimiento mostrado; si cambia, hay que volver a pedirlo. */
export const CONSENT_VERSION = "2026-11";

export const consentService = {
  async status(userId: string) {
    const p = await prisma.userProfile.findUnique({ where: { userId }, select: { aiPhotoConsent: true, consentAt: true } });
    return { granted: p?.aiPhotoConsent ?? false, at: p?.consentAt ?? null, version: CONSENT_VERSION };
  },
  async set(userId: string, granted: boolean) {
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, aiPhotoConsent: granted, consentAt: granted ? new Date() : null },
      update: { aiPhotoConsent: granted, consentAt: granted ? new Date() : null },
    });
    return this.status(userId);
  },
  /** Se comprueba en servidor antes de guardar o enviar cualquier foto personal. */
  async require(userId: string) {
    if (!(await this.status(userId)).granted) {
      throw new AppError("Necesitamos tu consentimiento explícito para usar fotos personales", 403, "CONSENT_REQUIRED");
    }
  },
};
