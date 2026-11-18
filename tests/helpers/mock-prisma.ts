import type { PrismaClient } from "@/generated/prisma/client";

/** Contenedor que los tests rellenan con el PrismaClient real conectado a PGlite. */
export function prismaProxy(holder: { prisma: PrismaClient | null }): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_t, prop) {
      const client = holder.prisma as unknown as Record<string | symbol, unknown>;
      const v = client[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(client) : v;
    },
  });
}

export function setTestEnv() {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://test", AUTH_SECRET: "x".repeat(32),
    CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key", CLOUDINARY_API_SECRET: "secret",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000", OPENROUTER_API_KEY: "or-test", POLLINATIONS_API_KEY: "sk_test",
  });
}
