import { prisma } from "@/lib/prisma";

export const userRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
  findById: (id: string) => prisma.user.findUnique({ where: { id }, include: { profile: true } }),
  create: (data: { email: string; name?: string; passwordHash: string }) =>
    prisma.user.create({ data: { ...data, profile: { create: {} } } }),
  /** `updateMany`: devuelve `{ count }` (0 si la cuenta ya no existe, p. ej. se borró tras consumir el token) en vez de lanzar P2025. */
  markVerified: (email: string) =>
    prisma.user.updateMany({ where: { email }, data: { emailVerified: new Date() } }),
  /**
   * Compare-and-set: cambia el hash solo si sigue siendo exactamente `expectedHash`. Devuelve cuántas filas se actualizaron
   * (1 si ganó, 0 si otro cambio o restablecimiento lo modificó antes). Acepta el cliente de una transacción interactiva.
   */
  async setPasswordIfUnchanged(userId: string, expectedHash: string, passwordHash: string, db: Pick<typeof prisma, "user"> = prisma) {
    return (await db.user.updateMany({ where: { id: userId, passwordHash: expectedHash }, data: { passwordHash } })).count;
  },
  /** Igual que `markVerified`: `{ count }`, nunca P2025 si la cuenta desapareció. */
  setPassword: (email: string, passwordHash: string) =>
    prisma.user.updateMany({ where: { email }, data: { passwordHash } }),
};
