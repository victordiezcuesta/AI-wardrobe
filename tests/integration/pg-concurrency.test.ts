import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Concurrencia REAL entre transacciones: PostgreSQL de verdad con varias conexiones independientes (PGlite no sirve:
 * es de una sola sesión). Solo se ejecuta si TEST_PG_URL apunta a un PostgreSQL LOCAL y desechable. Cómo levantarlo,
 * ejecutar estas pruebas y limpiarlo (también si el contenedor o el volumen ya existen): README, «11. Tests» →
 * «Concurrencia con PostgreSQL real». Resumen:
 *
 *   docker start ai-wardrobe-pgrace   # o, la primera vez: docker run … --tmpfs /var/lib/postgresql/data postgres:17-alpine
 *   PGPASSWORD=<contraseña del contenedor, vía docker inspect> \
 *     TEST_PG_URL=postgresql://postgres@127.0.0.1:55432/postgres npx vitest run tests/integration/pg-concurrency.test.ts
 *
 * Cada ejecución crea su propia base de datos (race_<aleatorio>), aplica la migración del proyecto y la elimina al
 * terminar. Se niega a ejecutarse contra hosts que no sean locales. Cloudinary está simulado (sin llamadas reales).
 */
const ADMIN_URL = process.env.TEST_PG_URL;
const isLocal = (u: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(u).hostname);

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const cloud = vi.hoisted(() => ({
  stored: new Set<string>(),
  deleted: [] as string[],
  /** Se ejecuta en cada borrado ANTES de completarlo (para observar el estado de la base de datos en ese instante). */
  onDelete: null as ((id: string) => Promise<void>) | null,
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/pollinations/client", () => ({ editImage: async () => Buffer.alloc(0) }));
vi.mock("@/lib/cloudinary", () => {
  const remove = async (ids: string[]) => {
    for (const id of ids) { await cloud.onDelete?.(id); cloud.deleted.push(id); cloud.stored.delete(id); } // idempotente, como Cloudinary
  };
  return {
    signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
    uploadPrivate: async () => { throw new Error("no usado"); },
    deletePrivateImages: remove,
    deleteImage: async (id: string | null | undefined) => { if (id) await remove([id]); },
    deleteImages: remove,
  };
});

let dbName = "";
let app: PrismaClient; // la que usan los servicios: pool de 4 conexiones, transacciones realmente en paralelo
let other: PrismaClient; // conexión independiente para mantener abierta «la otra» transacción
let monitor: PrismaClient; // conexión independiente para observar esperas de bloqueo

const client = (url: string, max: number) => new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });

beforeAll(async () => {
  if (!ADMIN_URL) return;
  if (!isLocal(ADMIN_URL)) throw new Error("TEST_PG_URL debe apuntar a un PostgreSQL local y desechable");
  setTestEnv();
  dbName = `race_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const setup = new pg.Client({ connectionString: url.toString() });
  await setup.connect();
  await setup.query(readFileSync(path.join(process.cwd(), "prisma/migrations/0001_init/migration.sql"), "utf8"));
  await setup.end();
  app = client(url.toString(), 4);
  other = client(url.toString(), 1);
  monitor = client(url.toString(), 1);
  holder.prisma = app;
}, 60_000);

/** Nombre de la base temporal de ESTA ejecución: lo único que la limpieza puede borrar. */
const TEMP_DB = /^race_[a-z0-9]{1,8}$/;

afterAll(async () => {
  if (!ADMIN_URL || !dbName) return;
  if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base de datos temporal inesperado: no se borra nada");
  // Primero se elimina la base temporal con FORCE, que termina también las sesiones que sigan conectadas (incluida una
  // transacción retenida por una prueba que haya fallado): la limpieza no depende de que $disconnect() termine antes.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await Promise.all([app?.$disconnect(), other?.$disconnect(), monitor?.$disconnect()]);
});

beforeEach(() => {
  if (!ADMIN_URL) return;
  holder.prisma = app;
  cloud.stored.clear(); cloud.deleted = []; cloud.onDelete = null;
});

/** Promesa abrible desde fuera. */
function gate() { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; }
/** Espera a que `inside` se abra; si `op` termina antes (p. ej. con un error), falla en ese momento en vez de colgarse. */
const reached = (inside: { wait: Promise<void> }, op: Promise<unknown>) =>
  Promise.race([inside.wait, op.then(
    () => { throw new Error("La operación terminó sin llegar a retener su transacción"); },
    (e: unknown) => { throw e; },
  )]);
const settled = async (p: Promise<unknown>) => Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 0))]);

/** Sesiones de ESTA base de datos que están esperando un bloqueo (pg_stat_activity). */
async function lockWaiters(): Promise<number> {
  const [r] = await monitor.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return r!.n;
}
async function waitForLockWaiters(n: number, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if ((await lockWaiters()) >= n) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`Ninguna transacción llegó a esperar un bloqueo (esperadas ${n})`);
}

const newUser = () => app.user.create({ data: { email: `c${Math.random().toString(36).slice(2)}@q.com` } });
async function sharedItems(userId: string, n: number) {
  const imagePublicId = `ai-wardrobe/${userId}/wardrobe/src-${Math.random().toString(36).slice(2)}`;
  cloud.stored.add(imagePublicId);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await app.wardrobeItem.create({ data: { userId, name: `P${i}`, category: "OTHER", imagePublicId } })).id);
  return { ids, imagePublicId };
}
const services = async () => ({
  wardrobe: (await import("@/services/wardrobe.service")).wardrobeService,
  tryOn: (await import("@/services/tryon.service")).tryOnService,
});

describe.skipIf(!ADMIN_URL)("PostgreSQL real con varias conexiones", () => {
  describe("prendas que comparten foto (SELECT … FOR UPDATE)", () => {
    it("B espera de verdad a la transacción de A; la foto se borra una vez, cuando B es la última referencia", async () => {
      const u = await newUser();
      const { wardrobe } = await services();
      const { ids, imagePublicId } = await sharedItems(u.id, 2);
      // Estado de la base de datos en el instante en que se pide borrar la foto.
      const refsAtDelete: number[] = [];
      cloud.onDelete = async (id) => { if (id === imagePublicId) refsAtDelete.push(await monitor.wardrobeItem.count({ where: { imagePublicId } })); };

      // A ejecuta su transacción real (bloquea, decide y borra su prenda) y se queda SIN confirmar hasta que la soltemos.
      const inside = gate();
      const release = gate();
      let gated = true;
      holder.prisma = new Proxy(app, {
        get(target, prop) {
          if (prop === "$transaction" && gated) {
            gated = false;
            return (cb: (tx: unknown) => Promise<unknown>, opts?: object) =>
              target.$transaction(async (tx) => { const r = await cb(tx); inside.open(); await release.wait; return r; }, { ...opts, timeout: 20_000 });
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as PrismaClient;

      const pA = wardrobe.remove(u.id, ids[0]!);
      let pB: Promise<void> | undefined;
      try {
        await reached(inside, pA); // A tiene las filas bloqueadas y su prenda borrada, sin confirmar
        pB = wardrobe.remove(u.id, ids[1]!); // otra conexión del pool
        await waitForLockWaiters(1); // B está bloqueada en el FOR UPDATE (pg_stat_activity: wait_event_type = Lock)
        expect(await settled(pB)).toBe(false);
        expect(cloud.deleted).toEqual([]); // nadie ha borrado la foto mientras A no confirma
      } finally {
        release.open(); // también si una aserción falla: la transacción de A no queda retenida
      }
      await Promise.all([pA, pB]);
      expect(await app.wardrobeItem.count({ where: { id: { in: ids } } })).toBe(0);
      expect(cloud.deleted.filter((d) => d === imagePublicId)).toHaveLength(1); // una sola vez
      expect(refsAtDelete).toEqual([1]); // al borrarla solo quedaba la prenda que se estaba borrando
      expect(cloud.stored.has(imagePublicId)).toBe(false); // sin huérfana
    });

    it("carga real: 25 rondas de 2 y de 3 borrados en paralelo (4 conexiones) → nunca queda la foto huérfana ni se borra antes de tiempo", async () => {
      const u = await newUser();
      const { wardrobe } = await services();
      for (let round = 0; round < 25; round++) {
        for (const n of [2, 3]) {
          const { ids, imagePublicId } = await sharedItems(u.id, n);
          const early: string[] = [];
          cloud.onDelete = async (id) => { if (id === imagePublicId && (await monitor.wardrobeItem.count({ where: { imagePublicId } })) > 1) early.push(id); };
          await Promise.all(ids.map((id) => wardrobe.remove(u.id, id)));
          expect(early).toEqual([]);
          expect(await app.wardrobeItem.count({ where: { id: { in: ids } } })).toBe(0);
          expect(cloud.stored.has(imagePublicId)).toBe(false);
        }
      }
    }, 60_000);
  });

  describe("probador: DELETE condicionado frente a la finalización de la generación", () => {
    async function generation(data: { status: "PROCESSING" | "COMPLETED"; publicId: string | null }) {
      const u = await newUser();
      const row = await app.generatedImage.create({ data: { userId: u.id, scenario: "studio", pose: "standing", ...data } });
      if (data.publicId) cloud.stored.add(data.publicId);
      return { userId: u.id, id: row.id };
    }

    it("la generación guarda su resultado en otra transacción mientras se borra → el DELETE espera, re-evalúa y no deja huérfano", async () => {
      const { userId, id } = await generation({ status: "PROCESSING", publicId: null });
      const { tryOn } = await services();
      const result = `ai-wardrobe/${userId}/try-on/result-1`;
      cloud.stored.add(result);

      // «run()» en otra conexión: guarda el resultado (mismo UPDATE que run) y aún no confirma.
      const inside = gate();
      const release = gate();
      const held = other.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "GeneratedImage" SET "status" = 'COMPLETED', "publicId" = ${result}, "updatedAt" = now() WHERE "id" = ${id}`;
        inside.open();
        await release.wait;
      }, { timeout: 20_000 });
      let pR: Promise<void> | undefined;
      try {
        await reached(inside, held);
        pR = tryOn.remove(userId, id); // lee la versión confirmada (sin resultado) y lanza su DELETE condicionado
        await waitForLockWaiters(1); // el DELETE espera el bloqueo de fila del UPDATE
        expect(await settled(pR)).toBe(false);
      } finally {
        release.open(); // también si una aserción falla: la transacción retenida termina
      }
      await held;
      await pR; // re-evalúa: publicId ya no coincide → 0 filas → relee → borra el resultado → borra la fila
      expect(await app.generatedImage.findUnique({ where: { id } })).toBeNull();
      expect(cloud.deleted).toContain(result);
      expect(cloud.stored.has(result)).toBe(false);
    });

    it("dos borrados de la misma generación en conexiones distintas, bloqueados a la vez → la fila se borra una vez, sin errores ni huérfanos", async () => {
      const result = `ai-wardrobe/x/try-on/result-${Math.random()}`;
      const { userId, id } = await generation({ status: "COMPLETED", publicId: result });
      const { tryOn } = await services();
      // Un bloqueo de fila ajeno hace que los dos DELETE coincidan esperando.
      const inside = gate();
      const release = gate();
      const held = other.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "GeneratedImage" WHERE "id" = ${id} FOR UPDATE`;
        inside.open();
        await release.wait;
      }, { timeout: 20_000 });
      let both: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await reached(inside, held);
        both = Promise.allSettled([tryOn.remove(userId, id), tryOn.remove(userId, id)]);
        await waitForLockWaiters(2);
      } finally {
        release.open(); // también si una aserción falla: la transacción retenida termina
      }
      await held;
      const results = await both!;
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]); // el segundo re-evalúa: ya no existe → hecho
      expect(await app.generatedImage.findUnique({ where: { id } })).toBeNull();
      expect(cloud.stored.has(result)).toBe(false);
    });
  });
});
