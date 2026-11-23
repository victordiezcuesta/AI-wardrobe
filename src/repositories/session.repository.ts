import { prisma } from "@/lib/prisma";

/**
 * Sesiones individuales revocables (modelo `Session`). `sessionToken` guarda el SHA-256 del `sid` que viaja en el JWT,
 * nunca el valor en claro. Los métodos devuelven PrismaPromise para poder combinarse en `prisma.$transaction([...])`.
 */
export const sessionRepository = {
  create: (userId: string, tokenHash: string, expires: Date) =>
    prisma.session.create({ data: { userId, sessionToken: tokenHash, expires }, select: { id: true } }),

  find: (tokenHash: string) =>
    prisma.session.findUnique({ where: { sessionToken: tokenHash }, select: { userId: true, expires: true } }),

  /** Renovación condicional: solo escribe si la fila sigue existiendo (una revocación concurrente no se deshace). */
  extend: (tokenHash: string, expires: Date) =>
    prisma.session.updateMany({ where: { sessionToken: tokenHash }, data: { expires } }),

  /** Idempotente: revocar una sesión ya revocada no es un error. */
  delete: (tokenHash: string) => prisma.session.deleteMany({ where: { sessionToken: tokenHash } }),

  /** Todas las sesiones del usuario salvo la de `keepTokenHash`. Acepta el cliente de una transacción interactiva. */
  deleteOthers: (userId: string, keepTokenHash: string, db: Pick<typeof prisma, "session"> = prisma) =>
    db.session.deleteMany({ where: { userId, sessionToken: { not: keepTokenHash } } }),

  deleteAllForEmail: (email: string) => prisma.session.deleteMany({ where: { user: { email } } }),

  deleteExpiredForUser: (userId: string, now: Date) => prisma.session.deleteMany({ where: { userId, expires: { lt: now } } }),
};
