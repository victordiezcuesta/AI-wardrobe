import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Recorre `src/` con `fs` (sin depender de `grep` del sistema). Devuelve las líneas que cumplen `pattern` como `archivo:línea: texto`. */
function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

export interface Hit { file: string; line: number; text: string }
export function scanSrc(pattern: RegExp, exts: readonly string[] = [".tsx", ".ts"], root = "src"): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(root, exts)) {
    readFileSync(file, "utf8").split("\n").forEach((text, i) => { if (pattern.test(text)) hits.push({ file, line: i + 1, text }); });
  }
  return hits;
}
export const filesOf = (hits: Hit[]) => [...new Set(hits.map((h) => h.file))];
