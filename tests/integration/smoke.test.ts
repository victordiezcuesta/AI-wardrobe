import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../helpers/db";

/** Una tabla por cada `model` del esquema (todas las migraciones aplicadas). */
const MODELS = (readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8").match(/^model\s+\w+\s*\{/gm) ?? []).length;

let t: TestDb;
beforeAll(async () => { t = await startTestDb(); }, 60_000);
afterAll(async () => { await t?.stop(); });

describe("migración + Prisma Client contra PostgreSQL real", () => {
  it("aplica todas las migraciones: una tabla por modelo del esquema", async () => {
    const r = await t.db.query<{ n: number }>(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
    expect(MODELS).toBeGreaterThanOrEqual(24); // 21 de 0001_init + 3 de 0002 (reconciliación de medios)
    expect(r.rows[0]!.n).toBe(MODELS);
  });
  it("crea un usuario con perfil y lo lee con relaciones", async () => {
    const u = await t.prisma.user.create({ data: { email: "a@b.co", passwordHash: "x", profile: { create: { usualStyles: ["casual"] } } } });
    const back = await t.prisma.user.findUnique({ where: { id: u.id }, include: { profile: true } });
    expect(back?.profile?.usualStyles).toEqual(["casual"]);
    expect(back?.createdAt).toBeInstanceOf(Date);
  });
  it("respeta enums, arrays y valores por defecto", async () => {
    const u = await t.prisma.user.findFirstOrThrow();
    const item = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Camisa", category: "SHIRT", seasons: ["SPRING", "SUMMER"] } });
    expect(item).toMatchObject({ status: "AVAILABLE", isFavorite: false, wearCount: 0, seasons: ["SPRING", "SUMMER"], secondaryColors: [] });
  });
});
