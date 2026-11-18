import { prisma } from "@/lib/prisma";

export const userRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),
  findById: (id: string) => prisma.user.findUnique({ where: { id }, include: { profile: true } }),
  create: (data: { email: string; name?: string; passwordHash: string }) =>
    prisma.user.create({ data: { ...data, profile: { create: {} } } }),
  markVerified: (email: string) =>
    prisma.user.update({ where: { email }, data: { emailVerified: new Date() } }),
  setPassword: (email: string, passwordHash: string) =>
    prisma.user.update({ where: { email }, data: { passwordHash } }),
};
