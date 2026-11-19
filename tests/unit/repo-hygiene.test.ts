import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "@/lib/env";

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
  it("coincide con lo que genera el esquema (no hay cambios sin migrar)", () => {
    const generated = execSync("npx tsx scripts/generate-migration.ts", { cwd: ROOT, encoding: "utf8", env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: "/bin/true" } });
    expect(generated.trim()).toBe(readFileSync(path.join(ROOT, "prisma/migrations/0001_init/migration.sql"), "utf8").trim());
  }, 60_000);
});
