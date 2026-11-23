import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Fase 19.14b — guardia de la purga de RateLimit. La purga borra filas con `windowStart` de hace más de 24 h; eso solo es
 * seguro mientras toda ventana de rate limiting sea MUCHO menor que la retención. Esta prueba recorre el AST de `src/` y
 * obliga a que cada llamada a `rateLimit`, `rateLimitByIp` y `rateLimitByEmail` tenga una ventana como literal numérico
 * ≤ 12 h, salvo los tres módulos que la reciben como parámetro o constante (cuyas constantes se comprueban aparte). Una
 * llamada nueva con una ventana no analizable (variable, expresión) hace fallar la prueba: hay que revisarla a propósito.
 */
const RETENTION_SEC = 24 * 3600;
const MAX_WINDOW_SEC = 12 * 3600; // la retención debe ser al menos el doble de cualquier ventana
const WINDOW_ARG_INDEX: Record<string, number> = { rateLimit: 2, rateLimitByIp: 3, rateLimitByEmail: 3 };
/** Módulos que no usan literales: los envoltorios (pasan su parámetro) y el login (constantes comprobadas en otra prueba). */
const NON_LITERAL_ALLOWED = new Set(["src/lib/rate-limit/ip.ts", "src/lib/rate-limit/email.ts", "src/lib/auth/login-limits.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (p.includes(`${join("src", "generated")}`)) return [];
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

interface Call { file: string; fn: string; window: number | null; line: number }
function collectCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    if (!/rateLimit(ByIp|ByEmail)?\s*\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in WINDOW_ARG_INDEX) {
        const fn = node.expression.text;
        const arg = node.arguments[WINDOW_ARG_INDEX[fn]!];
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        calls.push({ file: file.split("\\").join("/"), fn, window: arg && ts.isNumericLiteral(arg) ? Number(arg.text) : null, line });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return calls;
}

describe("ventanas de rate limiting frente a la retención de la purga", () => {
  const calls = collectCalls();
  // Las definiciones (`export async function rateLimit(...)`) no son llamadas; solo las invocaciones.
  const usage = calls.filter((c) => c.file !== "src/lib/rate-limit/index.ts");

  it("el analizador encuentra las llamadas reales (si no, la guardia no vigila nada)", () => {
    const literal = usage.filter((c) => c.window !== null);
    expect(literal.length).toBeGreaterThanOrEqual(15);
    for (const fn of ["rateLimit", "rateLimitByIp", "rateLimitByEmail"]) expect(usage.some((c) => c.fn === fn && c.window !== null), fn).toBe(true);
    expect(usage.some((c) => c.file === "src/app/api/auth/forgot-password/route.ts" && c.fn === "rateLimitByEmail" && c.window === 3600)).toBe(true);
  });
  it("toda llamada fuera de los módulos permitidos usa una ventana literal numérica", () => {
    const opaque = usage.filter((c) => c.window === null && !NON_LITERAL_ALLOWED.has(c.file));
    expect(opaque.map((c) => `${c.file}:${c.line} ${c.fn}`)).toEqual([]);
  });
  it("ninguna ventana literal supera las 12 h (la retención de 24 h es al menos el doble)", () => {
    const tooLong = usage.filter((c) => c.window !== null && c.window > MAX_WINDOW_SEC);
    expect(tooLong.map((c) => `${c.file}:${c.line} ${c.fn} ${c.window}s`)).toEqual([]);
    expect(RETENTION_SEC).toBeGreaterThanOrEqual(2 * MAX_WINDOW_SEC);
    const max = Math.max(...usage.filter((c) => c.window !== null).map((c) => c.window!));
    expect(max).toBeLessThanOrEqual(3600); // hoy: la mayor es de una hora
  });
  it("las constantes del login (único módulo con ventanas por constante) también están dentro del límite", async () => {
    const { LOGIN_LIMITS } = await import("@/lib/auth/login-limits");
    for (const [name, v] of Object.entries(LOGIN_LIMITS)) {
      expect(Number.isInteger(v.windowSec), name).toBe(true);
      expect(v.windowSec, name).toBeGreaterThan(0);
      expect(v.windowSec, name).toBeLessThanOrEqual(MAX_WINDOW_SEC);
    }
  });
  it("los envoltorios solo pasan su parámetro `windowSec` al limitador (no fijan otra ventana)", () => {
    for (const file of ["src/lib/rate-limit/ip.ts", "src/lib/rate-limit/email.ts"]) {
      const own = usage.filter((c) => c.file === file);
      expect(own.length, file).toBeGreaterThan(0);
      const text = readFileSync(file, "utf8");
      expect(text, file).toMatch(/rateLimit\([^)]*windowSec\)/);
    }
  });
});
