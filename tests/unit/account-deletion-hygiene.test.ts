import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fase 19.3 — MediaAsset no tiene FK a User: ninguna cascada lo borra. Estas pruebas estáticas garantizan que el ÚNICO
 * camino que elimina usuarios (accountService.delete) borra sus MediaAsset en la MISMA transacción, y fallan si aparece
 * otro camino (código propio o una versión de Auth.js que empiece a usar `adapter.deleteUser`, que no los limpiaría).
 */
const ROOT = process.cwd();
function files(dir: string, accept: (f: string) => boolean): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (p.includes(`${path.sep}generated${path.sep}`) || p.endsWith(`${path.sep}generated`)) return [];
    return statSync(p).isDirectory() ? files(p, accept) : accept(p) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(ROOT, p);
const SRC = files(path.join(ROOT, "src"), (f) => /\.(ts|tsx)$/.test(f)).map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));
const USER_DELETE = /\buser\.(delete|deleteMany)\s*\(|DELETE\s+FROM\s+"User"|\bdeleteUser\b|TRUNCATE\s+(TABLE\s+)?"User"/i;

describe("borrado de cuentas: un único camino y con limpieza de MediaAsset", () => {
  it("el único código que borra usuarios es accountService.delete", () => {
    expect(SRC.filter((s) => USER_DELETE.test(s.text)).map((s) => s.file)).toEqual(["src/services/account.service.ts"]);
  });

  it("borra los MediaAsset del usuario dentro de la MISMA transacción que la cuenta", () => {
    const text = SRC.find((s) => s.file === "src/services/account.service.ts")!.text;
    const tx = /await prisma\.\$transaction\(\[([\s\S]*?)\]\);/.exec(text.slice(text.indexOf("async delete(")));
    expect(tx).not.toBeNull();
    const body = tx![1]!;
    expect(body).toMatch(/prisma\.mediaAsset\.deleteMany\(\{ where: \{ ownerUserId: userId \} \}\)/);
    expect(body).toMatch(/prisma\.user\.delete\(\{ where: \{ id: userId \} \}\)/);
    // Fase 19.6.3: la PRIMERA sentencia bloquea la fila del usuario (orden User → MediaAsset, igual que la persistencia
    // de la reconciliación). Cualquier sentencia antes del bloqueo, o quitarlo, reabre el interbloqueo.
    const statements = body.replace(/^\s*\/\/.*$/gm, "").trim();
    expect(statements.startsWith('prisma.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`,')).toBe(true);
    // Nada de MediaAsset fuera de esa transacción (una limpieza previa o posterior podría quedar a medias).
    expect(text.match(/mediaAsset\./g)).toHaveLength(1);
  });

  it("Auth.js no llama a adapter.deleteUser (el PrismaAdapter borraría el usuario sin limpiar MediaAsset)", () => {
    const pkgs = ["@auth/core", "next-auth"].map((p) => path.join(ROOT, "node_modules", p));
    const runtime = pkgs.flatMap((dir) => files(dir, (f) => /\.(c|m)?js$/.test(f)));
    expect(runtime.length).toBeGreaterThan(0);
    const callers = runtime.filter((f) => /deleteUser/.test(readFileSync(f, "utf8"))).map(rel);
    expect(callers).toEqual([]);
  });
});
