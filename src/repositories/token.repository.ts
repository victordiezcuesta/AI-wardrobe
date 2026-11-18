import { prisma } from "@/lib/prisma";

export type TokenKind = "VERIFY_EMAIL" | "RESET_PASSWORD";

export const tokenRepository = {
  async replace(identifier: string, kind: TokenKind, tokenHash: string, expires: Date) {
    await prisma.verificationToken.deleteMany({ where: { identifier, kind } });
    return prisma.verificationToken.create({ data: { identifier, kind, token: tokenHash, expires } });
  },
  find: (tokenHash: string, kind: TokenKind) =>
    prisma.verificationToken.findFirst({ where: { token: tokenHash, kind } }),
  delete: (tokenHash: string) => prisma.verificationToken.deleteMany({ where: { token: tokenHash } }),
};
