import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.14c — GET /api/cron/rate-limit-purge con el servicio REAL sobre PGlite: ruta + autorización + purga extremo a
 * extremo. Solo se simula `@/lib/env` para fijar CRON_SECRET (env() real cachea el entorno). Los casos con el servicio
 * simulado y la proyección de la respuesta están en tests/unit/rate-limit-purge-route.test.ts.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const envState = vi.hoisted(() => ({ secret: undefined as string | undefined }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/env", () => ({ env: () => ({ CRON_SECRET: envState.secret }) }));

const SECRET = ["cron", "prueba", "0123456789abcdef"].join("-"); // ficticio (sin literal: regla de higiene)
let t: TestDb;
let GET: (req: Request) => Promise<Response>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  GET = ((await import("@/app/api/cron/rate-limit-purge/route")) as { GET: (req: Request) => Promise<Response> }).GET;
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  envState.secret = SECRET;
  await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { envState.secret = undefined; vi.restoreAllMocks(); });

const insert = (key: string, hoursAgo: number, count = 1) =>
  t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('${key}', ${count}, NOW() - INTERVAL '${hoursAgo} hours')`);
const keys = async () => (await t.prisma.rateLimit.findMany({ select: { key: true }, orderBy: { key: "asc" } })).map((r) => r.key);
const call = (auth?: string, query = "") => GET(new Request(`http://localhost:3000/api/cron/rate-limit-purge${query}`, { headers: auth === undefined ? {} : { authorization: auth } }));

describe("extremo a extremo", () => {
  it("con el secreto correcto purga las filas caducadas, conserva las recientes y responde solo con los totales", async () => {
    await insert("login:ana@example.com", 30); await insert("register:v4:203.0.113.7", 25); await insert("forgot-email:0123456789abcdef0123456789abcdef", 48);
    await insert("login:otra@example.com", 2); await insert("photos:cuid1", 23);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, deleted: 3, batches: 1, complete: true });
    for (const secret of ["ana@example.com", "203.0.113.7", "forgot-email", "0123456789abcdef"]) expect(text, secret).not.toContain(secret);
    expect(await keys()).toEqual(["login:otra@example.com", "photos:cuid1"]);
  });
  it("es idempotente: la segunda llamada no borra nada", async () => {
    await insert("viejo", 30); await insert("reciente", 1);
    await call(`Bearer ${SECRET}`);
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, deleted: 0, batches: 1, complete: true });
    expect(await keys()).toEqual(["reciente"]);
  });
  it("sin credenciales, con secreto incorrecto o sin CRON_SECRET configurado: 401 y la tabla queda INTACTA", async () => {
    await insert("viejo:1", 30); await insert("viejo:2", 90); await insert("reciente", 1);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${SECRET.slice(0, -1)}X`)).status).toBe(401);
    envState.secret = undefined;
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    expect(await keys()).toEqual(["reciente", "viejo:1", "viejo:2"]);
  });
  it("los parámetros de la URL no cambian la política: una fila de 2 h no se borra por pedir retentionHours=1", async () => {
    await insert("dos-horas", 2); await insert("treinta-horas", 30);
    const res = await call(`Bearer ${SECRET}`, "?retentionHours=1&batchSize=1&maxBatches=1&budgetMs=1");
    expect(await res.json()).toEqual({ ok: true, deleted: 1, batches: 1, complete: true });
    expect(await keys()).toEqual(["dos-horas"]);
  });
  it("un error real de SQL da 500 genérico (sin claves en la respuesta ni en los logs) y no modifica nada", async () => {
    await insert("login:secreto@example.com", 30);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "RateLimit" RENAME TO "RateLimitX"`);
    try {
      const res = await call(`Bearer ${SECRET}`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
      const logged = errSpy.mock.calls.flat().map(String).join("\n");
      for (const secret of ["secreto@example.com", "login:"]) { expect(text, secret).not.toContain(secret); expect(logged, secret).not.toContain(secret); }
    } finally { await t.prisma.$executeRawUnsafe(`ALTER TABLE "RateLimitX" RENAME TO "RateLimit"`); }
    expect(await keys()).toEqual(["login:secreto@example.com"]);
  });
  it("convive con el limitador: tras la purga, rateLimit sigue contando con normalidad", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    await insert("t:vieja", 30, 99);
    await call(`Bearer ${SECRET}`);
    await rateLimit("t:vieja", 2, 60);
    expect((await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "t:vieja" } })).count).toBe(1);
  });
});
