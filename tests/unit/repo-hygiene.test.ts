import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "@/lib/env";
import { listMigrations } from "../helpers/migrations";

const ROOT = process.cwd();
const TEXT_EXT = /\.(ts|tsx|js|mjs|json|md|css|sql|toml|yml|yaml|example|env|txt)$/;
const git = (args: string) => execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" });

/**
 * Archivos que Git versiona o versionaría (seguidos + nuevos no ignorados). Lo que .gitignore excluye
 * (.env local, node_modules, .next, src/generated…) no se sube al repositorio, así que no se inspecciona.
 */
function repoFiles(): string[] {
  return git("ls-files -z --cached --others --exclude-standard")
    .split("\0")
    .filter((f) => f && existsSync(path.join(ROOT, f)))
    .filter((f) => TEXT_EXT.test(f) || path.basename(f).startsWith(".env"))
    .map((f) => path.join(ROOT, f));
}

describe(".env.example", () => {
  const lines = readFileSync(path.join(ROOT, ".env.example"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const declared = new Map(lines.map((l) => [l.split("=")[0]!, l.slice(l.indexOf("=") + 1)]));

  it("declara todas las variables que lee la aplicación", () => {
    const missing = ENV_KEYS.filter((k) => !declared.has(k));
    expect(missing).toEqual([]);
  });
  it("incluye al menos las variables mínimas exigidas", () => {
    for (const k of ["DATABASE_URL", "DIRECT_URL", "AUTH_SECRET", "AUTH_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "OPENROUTER_API_KEY", "OPENROUTER_MODEL_VISION", "POLLINATIONS_API_KEY", "POLLINATIONS_MODEL", "NEXT_PUBLIC_APP_URL"]) {
      expect(declared.has(k), k).toBe(true);
    }
  });
  it("no contiene valores reales (todas las variables vacías)", () => {
    expect([...declared].filter(([, v]) => v !== "").map(([k]) => k)).toEqual([]);
  });
});

describe("secretos en el repositorio", () => {
  const PATTERNS: [string, RegExp][] = [
    ["clave sk_ de Pollinations/Stripe", /\bsk_(live|test)?_?[A-Za-z0-9]{20,}\b/],
    ["clave de OpenRouter", /\bsk-or-v1-[A-Za-z0-9]{20,}/],
    ["clave privada PEM", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["URL de Cloudinary con credenciales", /cloudinary:\/\/\d+:[A-Za-z0-9_-]{10,}@/],
    ["cadena de conexión con contraseña", /postgres(ql)?:\/\/[^:\s/]+:(?!password|contraseña|PASSWORD|xxxx|\*+)[^@\s"'`]{8,}@/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["token de GitHub", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
    ["asignación de secreto literal", /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["'][A-Za-z0-9/+_=-]{24,}["']/i],
  ];
  const files = repoFiles().filter((f) => !f.endsWith("package-lock.json"));

  it("recorre el proyecto", () => { expect(files.length).toBeGreaterThan(100); });
  it.each(PATTERNS)("no hay %s", (_name, re) => {
    const hits = files.filter((f) => !f.includes("repo-hygiene.test.ts") && re.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
  it("no hay ficheros .env con valores en el repositorio y están en .gitignore", () => {
    const isEnv = (f: string) => /^\.env(\.|$)/.test(path.basename(f)) && path.basename(f) !== ".env.example";
    expect(files.map((f) => path.relative(ROOT, f)).filter(isEnv)).toEqual([]);
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^\.env\.local$/m);
    // Git debe ignorarlos de verdad (check-ignore lanza si el archivo NO está ignorado).
    for (const f of [".env", ".env.local"]) expect(() => git(`check-ignore -q ${f}`), f).not.toThrow();
  });
});

describe("migración", () => {
  /**
   * Sentencias SQL normalizadas: sin comentarios de línea y con los espacios colapsados. Las migraciones no usan `;` dentro
   * de literales; si alguna lo hiciera, sus fragmentos no coincidirían con nada y el test fallaría (nunca pasa en falso).
   */
  const statements = (sql: string) => sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

  /**
   * Sentencias MANUALES autorizadas, por migración, escritas LITERALMENTE (no por patrón): solo lo que Prisma no puede
   * representar. Cualquier cambio en ellas obliga a actualizar esta lista a propósito.
   * - 0002_media_reconcile_persistence: restricciones CHECK de integridad (18) y la siembra idempotente del lease (1).
   */
  const MANUAL: Record<string, string[]> = {
    "0002_media_reconcile_persistence": [
      "ALTER TABLE \"MediaReconcileLock\" ADD CONSTRAINT \"MediaReconcileLock_name_check\" CHECK (\"name\" = 'media-reconcile')",
      "ALTER TABLE \"MediaReconcileLock\" ADD CONSTRAINT \"MediaReconcileLock_fencingToken_check\" CHECK (\"fencingToken\" >= 0)",
      "ALTER TABLE \"MediaReconcileLock\" ADD CONSTRAINT \"MediaReconcileLock_lease_check\" CHECK (((\"holderRunId\" IS NULL) = (\"leaseExpiresAt\" IS NULL)) AND (\"holderRunId\" IS NULL OR (\"heartbeatAt\" IS NOT NULL AND \"heartbeatAt\" <= \"leaseExpiresAt\")))",
      "ALTER TABLE \"MediaReconcileRun\" ADD CONSTRAINT \"MediaReconcileRun_fencingToken_check\" CHECK (\"fencingToken\" > 0)",
      "ALTER TABLE \"MediaReconcileRun\" ADD CONSTRAINT \"MediaReconcileRun_graceHours_check\" CHECK (\"graceHours\" >= 1 AND \"graceHours\" <= 8760)",
      "ALTER TABLE \"MediaReconcileRun\" ADD CONSTRAINT \"MediaReconcileRun_finished_check\" CHECK (((\"status\" = 'RUNNING') = (\"finishedAt\" IS NULL)) AND (\"finishedAt\" IS NULL OR \"finishedAt\" >= \"startedAt\") AND \"heartbeatAt\" >= \"startedAt\" AND (\"finishedAt\" IS NULL OR \"heartbeatAt\" <= \"finishedAt\"))",
      "ALTER TABLE \"MediaReconcileRun\" ADD CONSTRAINT \"MediaReconcileRun_complete_check\" CHECK ((\"complete\" = (\"status\" = 'COMPLETED')) AND (NOT \"complete\" OR \"inventoryComplete\"))",
      "ALTER TABLE \"MediaReconcileRun\" ADD CONSTRAINT \"MediaReconcileRun_codeVersion_check\" CHECK (\"codeVersion\" IS NULL OR char_length(\"codeVersion\") BETWEEN 1 AND 64)",
      "ALTER TABLE \"MediaReconcileRun\" ADD CONSTRAINT \"MediaReconcileRun_errorCodes_check\" CHECK (\"errorCodes\" IS NULL OR cardinality(\"errorCodes\") <= 64)",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_assetId_check\" CHECK (char_length(\"assetId\") BETWEEN 1 AND 128 AND \"assetId\" !~ '[\\u0001-\\u0020\\u007F-\\u00A0\\u00AD\\u1680\\u180E\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u206F\\u3000\\uFEFF]')",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_publicId_check\" CHECK (char_length(\"publicId\") <= 1024 AND \"publicId\" ~ '^ai-wardrobe/[A-Za-z0-9-][A-Za-z0-9_-]{0,63}/(wardrobe|personal|try-on)/[^/]+$')",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_ownerUserId_check\" CHECK (\"ownerUserId\" = split_part(\"publicId\", '/', 2))",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_kind_check\" CHECK (split_part(\"publicId\", '/', 3) = CASE \"kind\" WHEN 'WARDROBE' THEN 'wardrobe' WHEN 'PERSONAL' THEN 'personal' WHEN 'TRY_ON' THEN 'try-on' END)",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_delivery_check\" CHECK ((\"kind\" = 'WARDROBE') = (\"delivery\" = 'UPLOAD'))",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_metadata_check\" CHECK ((\"version\" IS NULL OR \"version\" >= 1) AND (\"bytes\" IS NULL OR \"bytes\" >= 0) AND (\"format\" IS NULL OR char_length(\"format\") BETWEEN 1 AND 16))",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_counters_check\" CHECK (\"sightings\" >= 1 AND \"rowVersion\" >= 0 AND \"lastCandidateAt\" >= \"firstCandidateAt\")",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_sightings_runs_check\" CHECK ((\"sightings\" = 1) = (\"firstCandidateRunId\" = \"lastCandidateRunId\"))",
      "ALTER TABLE \"MediaAsset\" ADD CONSTRAINT \"MediaAsset_confirmed_check\" CHECK (\"state\" <> 'CONFIRMED' OR (\"sightings\" >= 2 AND \"lastCandidateAt\" - \"firstCandidateAt\" >= INTERVAL '1 hour'))",
      "INSERT INTO \"MediaReconcileLock\" (\"name\", \"fencingToken\", \"createdAt\", \"updatedAt\") VALUES ('media-reconcile', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (\"name\") DO NOTHING",
    ],
  };
  /** Huella de 0001_init: la migración inicial no se reescribe nunca (cualquier cambio debe ir en una migración nueva). */
  const INIT_SHA256 = "eced53d4430e4cfb849b89662071b808b72d323a9ef0f796517d02494a57abd8";

  /**
   * Comparación ESTRICTA, sin filtros: cada sentencia de cada migración debe ser (a) una sentencia del DDL que genera el
   * esquema, que se consume (no puede repetirse), o (b) una sentencia manual autorizada de ESA migración. Cualquier otra
   * (DROP, RENAME, ALTER COLUMN, DROP NOT NULL, DROP INDEX, UPDATE…) hace fallar el test. Al terminar no puede sobrar DDL
   * del esquema (modelos sin migrar) ni quedar una sentencia manual autorizada sin usar.
   *
   * Limitación conocida: el script genera el esquema COMPLETO como sentencias CREATE. Mientras todas las migraciones solo
   * creen objetos nuevos, la comparación es exacta. La primera migración incremental (p. ej. ALTER TABLE … ADD COLUMN o
   * un cambio de tipo) no podrá emparejarse con el CREATE TABLE generado y este test fallará: en ese momento habrá que
   * sustituirlo por una comparación de catálogos (aplicar las migraciones en una base PGlite, aplicar el DDL generado en
   * otra y comparar information_schema/pg_catalog), no relajarlo.
   */
  type Migration = { name: string; sql: string };
  let generatedCache: string | undefined;
  const generated = () => (generatedCache ??= execSync("npx tsx scripts/generate-migration.ts", { cwd: ROOT, encoding: "utf8", env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: "/bin/true" } }));
  function compare(migrations: Migration[]) {
    const pending = new Map<string, number>();
    for (const s of statements(generated())) pending.set(s, (pending.get(s) ?? 0) + 1);
    const unexpected: string[] = [];
    const unusedManual: string[] = [];
    for (const m of migrations) {
      const manual = [...(MANUAL[m.name] ?? [])];
      for (const s of statements(m.sql)) {
        const n = pending.get(s) ?? 0;
        if (n > 0) { pending.set(s, n - 1); continue; }
        const i = manual.indexOf(s);
        if (i !== -1) { manual.splice(i, 1); continue; }
        unexpected.push(`${m.name}: ${s.slice(0, 160)}`);
      }
      unusedManual.push(...manual.map((s) => `${m.name}: ${s.slice(0, 160)}`));
    }
    const unmigrated = [...pending].flatMap(([s, n]) => Array.from({ length: n }, () => s.slice(0, 160)));
    return { unexpected, unmigrated, unusedManual };
  }

  it("cada sentencia de las migraciones es DDL del esquema o una sentencia manual autorizada; no falta ni sobra nada", () => {
    const migrations = listMigrations();
    expect(compare(migrations)).toEqual({ unexpected: [], unmigrated: [], unusedManual: [] });
    expect(Object.keys(MANUAL).filter((k) => !migrations.some((m) => m.name === k))).toEqual([]);
  }, 60_000);

  describe("la comparación detecta de verdad los cambios no autorizados (sobre copias alteradas de las migraciones reales)", () => {
    const LAST = "0002_media_reconcile_persistence";
    const alter = (fn: (sql: string) => string) => listMigrations().map((m) => (m.name === LAST ? { ...m, sql: fn(m.sql) } : m));
    it.each([
      ["DROP INDEX", `DROP INDEX "MediaAsset_ownerUserId_idx";`],
      ["DROP NOT NULL", `ALTER TABLE "MediaAsset" ALTER COLUMN "ownerUserId" DROP NOT NULL;`],
      ["ALTER COLUMN TYPE", `ALTER TABLE "MediaAsset" ALTER COLUMN "bytes" TYPE BIGINT;`],
      ["RENAME", `ALTER TABLE "User" RENAME COLUMN "email" TO "mail";`],
      ["DROP TABLE", `DROP TABLE "RateLimit";`],
      ["CHECK autorizado con una acción extra", `ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_x_check" CHECK (true), DROP COLUMN "publicId";`],
      ["UPDATE de datos", `UPDATE "MediaReconcileLock" SET "fencingToken" = 0;`],
      ["índice que el esquema no declara", `CREATE INDEX "MediaAsset_assetId_idx" ON "MediaAsset"("assetId");`],
      ["sentencia autorizada repetida", `INSERT INTO "MediaReconcileLock" ("name", "fencingToken", "createdAt", "updatedAt") VALUES ('media-reconcile', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT ("name") DO NOTHING;`],
    ])("%s añadido a una migración → sentencia no autorizada", (_n, extra) => {
      expect(compare(alter((sql) => `${sql}\n${extra}\n`)).unexpected).toHaveLength(1);
    }, 60_000);

    it("DDL del esquema que falta en las migraciones → cambios sin migrar", () => {
      const r = compare(alter((sql) => sql.replace(/CREATE INDEX "MediaAsset_ownerUserId_idx"[^;]*;/, "")));
      expect(r.unmigrated).toEqual([`CREATE INDEX "MediaAsset_ownerUserId_idx" ON "MediaAsset"("ownerUserId")`]);
    }, 60_000);

    it("una sentencia manual autorizada que desaparece → la lista autorizada ya no refleja la realidad", () => {
      const r = compare(alter((sql) => sql.replace(/ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_confirmed_check"[^;]*;/, "")));
      expect(r.unusedManual).toHaveLength(1);
      expect(r.unexpected).toEqual([]);
    }, 60_000);

    it("una sentencia manual de 0002 en OTRA migración no está autorizada", () => {
      const moved = MANUAL[LAST]![0]!;
      const r = compare(listMigrations().map((m) => (m.name === "0001_init" ? { ...m, sql: `${m.sql}\n${moved};\n` } : m)));
      expect(r.unexpected).toHaveLength(1);
    }, 60_000);
  });

  it("0001_init no se ha modificado y solo contiene DDL derivado del esquema (sin sentencias manuales)", () => {
    const text = readFileSync(path.join(ROOT, "prisma/migrations/0001_init/migration.sql"));
    expect(createHash("sha256").update(text).digest("hex")).toBe(INIT_SHA256);
    expect(MANUAL["0001_init"]).toBeUndefined();
  });
});
