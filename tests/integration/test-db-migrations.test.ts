import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestDb } from "../helpers/db";
import { applyMigrations, listMigrations, MIGRATIONS_DIR, type Migration } from "../helpers/migrations";

/**
 * Fase 19.2.1 — el entorno de pruebas aplica TODAS las migraciones de `prisma/migrations`, en orden, una sola vez, y un
 * fallo nunca deja una base de datos aparentemente válida. Las pruebas no dependen de ninguna migración futura concreta:
 * comparan con lo que haya en el directorio y usan migraciones de ejemplo en directorios temporales.
 */
const tmpDirs: string[] = [];
function fixtureDir(entries: Record<string, string | null>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiw-migrations-"));
  tmpDirs.push(dir);
  for (const [name, sql] of Object.entries(entries)) {
    if (name.endsWith(".toml")) { writeFileSync(path.join(dir, name), sql ?? ""); continue; }
    mkdirSync(path.join(dir, name));
    if (sql !== null) writeFileSync(path.join(dir, name, "migration.sql"), sql);
  }
  return dir;
}
afterEach(() => { vi.restoreAllMocks(); for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const mig = (name: string, sql: string): Migration => ({ name, sql });

describe("listMigrations (descubrimiento y orden)", () => {
  it("las migraciones reales: todas las del directorio, ordenadas, con SQL, empezando por 0001_init", () => {
    const list = listMigrations();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.name).toBe("0001_init");
    const names = list.map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    for (const m of list) expect(m.sql.trim().length).toBeGreaterThan(0);
    expect(path.relative(process.cwd(), MIGRATIONS_DIR)).toBe(path.join("prisma", "migrations"));
  });

  it("ordena por nombre como Prisma (también con marcas de tiempo) e ignora archivos sueltos", () => {
    const dir = fixtureDir({
      "0010_c": "SELECT 3;", "0002_b": "SELECT 2;", "0001_a": "SELECT 1;",
      "20260102000000_t2": "SELECT 5;", "20260101000000_t1": "SELECT 4;", "migration_lock.toml": 'provider = "postgresql"',
    });
    expect(listMigrations(dir).map((m) => m.name)).toEqual(["0001_a", "0002_b", "0010_c", "20260101000000_t1", "20260102000000_t2"]);
  });

  it.each([
    ["sin migration.sql", { "0001_a": "SELECT 1;", "0002_b": null }, /0002_b no tiene migration.sql/],
    ["migration.sql vacío", { "0001_a": "SELECT 1;", "0002_b": "  \n" }, /0002_b está vacía/],
    ["nombre no válido", { "0001_a": "SELECT 1;", "borrador": "SELECT 2;" }, /nombre no válido: borrador/],
    ["ninguna migración", { "migration_lock.toml": "" }, /No hay migraciones/],
  ])("%s → error (nunca una lista parcial)", (_n, entries, msg) => {
    expect(() => listMigrations(fixtureDir(entries))).toThrow(msg);
  });
});

describe("applyMigrations (una vez, en orden, deteniéndose en el fallo)", () => {
  it("aplica cada migración exactamente una vez y en el orden recibido", async () => {
    const run = vi.fn(async (_sql: string) => undefined);
    const applied = await applyMigrations(run, [mig("0001_a", "A"), mig("0002_b", "B"), mig("0003_c", "C")]);
    expect(applied).toEqual(["0001_a", "0002_b", "0003_c"]);
    expect(run.mock.calls.map((c) => c[0])).toEqual(["A", "B", "C"]);
  });

  it("si una falla: error con su nombre y la causa; las anteriores sí se aplicaron y las siguientes no", async () => {
    const boom = new Error("syntax error");
    const run = vi.fn(async (sql: string) => { if (sql === "B") throw boom; });
    const err = await applyMigrations(run, [mig("0001_a", "A"), mig("0002_b", "B"), mig("0003_c", "C")]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("La migración 0002_b falló (aplicadas antes: 0001_a)");
    expect((err as Error & { cause?: unknown }).cause).toBe(boom);
    expect(run.mock.calls.map((c) => c[0])).toEqual(["A", "B"]);
  });

  it("nombres repetidos → error ANTES de ejecutar nada", async () => {
    const run = vi.fn(async (_sql: string) => undefined);
    await expect(applyMigrations(run, [mig("0001_a", "A"), mig("0001_a", "A")])).rejects.toThrow("Migración duplicada: 0001_a");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("startTestDb con PGlite", () => {
  it("aplica todas las migraciones disponibles, en orden y una sola vez", async () => {
    const exec = vi.spyOn(PGlite.prototype, "exec");
    const expected = listMigrations();
    const t = await startTestDb();
    try {
      expect(t.migrations).toEqual(expected.map((m) => m.name));
      expect(exec.mock.calls.map((c) => c[0])).toEqual(expected.map((m) => m.sql)); // ni repetidas ni de más
      const { rows } = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User'`);
      expect(rows[0]!.n).toBe(1);
      expect(await t.prisma.user.count()).toBe(0); // Prisma funciona sobre el esquema migrado
    } finally { await t.stop(); }
  }, 60_000);

  it("el orden importa y se respeta: una migración posterior puede depender de la anterior", async () => {
    const t = await startTestDb({ migrations: [
      mig("0001_base", `CREATE TABLE "OrdenPrueba" ("id" INTEGER PRIMARY KEY);`),
      mig("0002_extra", `ALTER TABLE "OrdenPrueba" ADD COLUMN "nota" TEXT; INSERT INTO "OrdenPrueba" VALUES (1, 'ok');`),
    ] });
    try {
      expect(t.migrations).toEqual(["0001_base", "0002_extra"]);
      const { rows } = await t.db.query<{ nota: string }>(`SELECT "nota" FROM "OrdenPrueba"`);
      expect(rows).toEqual([{ nota: "ok" }]);
    } finally { await t.stop(); }
  }, 60_000);

  it("una migración que falla propaga el error, no devuelve ninguna base de datos y cierra PGlite", async () => {
    const close = vi.spyOn(PGlite.prototype, "close");
    const exec = vi.spyOn(PGlite.prototype, "exec");
    const err = await startTestDb({ migrations: [
      mig("0001_base", `CREATE TABLE "FalloPrueba" ("id" INTEGER PRIMARY KEY);`),
      mig("0002_rota", `ALTER TABLE "NoExiste" ADD COLUMN "x" TEXT;`),
      mig("0003_nunca", `CREATE TABLE "NuncaCreada" ("id" INTEGER);`),
    ] }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("La migración 0002_rota falló (aplicadas antes: 0001_base)");
    expect(String((err as Error & { cause?: unknown }).cause)).toMatch(/NoExiste/);
    expect(exec).toHaveBeenCalledTimes(2); // 0003 no llega a ejecutarse
    // La instancia del helper (la que ejecutó las migraciones) quedó cerrada. PGlite puede llamar a close también en
    // instancias internas, así que no se cuenta el número de llamadas.
    const db = exec.mock.contexts[0] as PGlite;
    expect(new Set(exec.mock.contexts).size).toBe(1);
    expect(close.mock.contexts).toContain(db);
    expect(db.closed).toBe(true);
  }, 60_000);

  it("migraciones de un directorio con una rota → error al descubrirlas, antes de crear PGlite", async () => {
    const dir = fixtureDir({ "0001_a": "SELECT 1;", "0002_b": null });
    const exec = vi.spyOn(PGlite.prototype, "exec");
    await expect((async () => startTestDb({ migrations: listMigrations(dir) }))()).rejects.toThrow(/no tiene migration.sql/);
    expect(exec).not.toHaveBeenCalled();
  });
});
