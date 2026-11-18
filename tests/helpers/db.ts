import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

export interface TestDb { prisma: PrismaClient; db: PGlite; stop: () => Promise<void> }

/**
 * PostgreSQL real (PGlite) con la migración del proyecto aplicada y un PrismaClient auténtico conectado por red.
 * Así los tests de integración ejecutan los mismos repositorios y servicios que producción.
 */
export async function startTestDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(readFileSync(path.join(process.cwd(), "prisma/migrations/0001_init/migration.sql"), "utf8"));
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();
  const adapter = new PrismaPg({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, max: 1 });
  const prisma = new PrismaClient({ adapter });
  return { prisma, db, stop: async () => { await prisma.$disconnect(); await server.stop(); await db.close(); } };
}
