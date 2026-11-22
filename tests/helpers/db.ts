import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { applyMigrations, listMigrations, type Migration } from "./migrations";

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

/** `migrations`: nombres de las migraciones aplicadas, en el orden en que se aplicaron. */
export interface TestDb { prisma: PrismaClient; db: PGlite; migrations: string[]; stop: () => Promise<void> }

/**
 * PostgreSQL real (PGlite) con TODAS las migraciones del proyecto aplicadas en orden y un PrismaClient auténtico
 * conectado por red. Así los tests de integración ejecutan los mismos repositorios y servicios que producción.
 *
 * Si algo falla (una migración o el arranque del servidor), se cierra todo lo que se hubiera abierto y se propaga el
 * error: nunca se devuelve una base de datos a medio inicializar. `opts.migrations` solo sirve para probar el propio helper.
 */
export async function startTestDb(opts: { migrations?: readonly Migration[] } = {}): Promise<TestDb> {
  const migrations = opts.migrations ?? listMigrations();
  const db = new PGlite();
  let server: PGLiteSocketServer | undefined;
  try {
    const applied = await applyMigrations((sql) => db.exec(sql), migrations);
    const port = await freePort();
    server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
    await server.start();
    const adapter = new PrismaPg({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, max: 1 });
    const prisma = new PrismaClient({ adapter });
    const srv = server;
    return { prisma, db, migrations: applied, stop: async () => { await prisma.$disconnect(); await srv.stop(); await db.close(); } };
  } catch (err) {
    await server?.stop().catch(() => undefined);
    await db.close().catch(() => undefined);
    throw err;
  }
}
