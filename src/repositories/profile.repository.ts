import { prisma } from "@/lib/prisma";
import type { ProfileInput } from "@/lib/validations/profile";

export const profileRepository = {
  get: (userId: string) => prisma.userProfile.findUnique({ where: { userId } }),
  async upsert(userId: string, data: ProfileInput) {
    const { name, ...rest } = data;
    if (name !== undefined) await prisma.user.update({ where: { id: userId }, data: { name: name || null } });
    return prisma.userProfile.upsert({
      where: { userId },
      create: { userId, ...rest },
      update: rest,
    });
  },
};
