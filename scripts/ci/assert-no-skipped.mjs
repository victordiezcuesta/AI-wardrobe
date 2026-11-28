// Comprueba uno o varios informes JSON de Vitest: la CI no debe tener pruebas fallidas, omitidas ni pendientes.
// Una prueba omitida significa que una suite opt-in (p. ej. las de PostgreSQL real) no se ha ejecutado: la CI falla
// en vez de dar un verde engañoso. Uso: node scripts/ci/assert-no-skipped.mjs <informe.json> [<informe.json>…]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) { console.error("Uso: node scripts/ci/assert-no-skipped.mjs <informe.json> [<informe.json>…]"); process.exit(2); }

// Todos los archivos `*.test.ts(x)` de tests/ (la configuración de Vitest solo incluye esos).
const testFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? testFiles(path.join(dir, e.name)) : /\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
const expected = new Set(testFiles("tests").map((f) => path.normalize(f)));
const seen = new Map();

const total = { archivos: 0, pruebas: 0, correctas: 0, fallidas: 0, omitidas: 0, todo: 0 };
const bad = [];
for (const file of files) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  const n = (k) => Number(r[k] ?? 0);
  const part = { archivos: (r.testResults ?? []).length, pruebas: n("numTotalTests"), correctas: n("numPassedTests"), fallidas: n("numFailedTests"), omitidas: n("numPendingTests"), todo: n("numTodoTests") };
  console.log(`${file}: ${JSON.stringify(part)}`);
  for (const f of r.testResults ?? []) { const rel = path.relative(process.cwd(), f.name); seen.set(rel, (seen.get(rel) ?? 0) + 1); }
  for (const k of Object.keys(total)) total[k] += part[k];
  if (!r.success) bad.push(`${file}: el informe indica que la ejecución no fue correcta`);
  if (part.pruebas === 0) bad.push(`${file}: no se ejecutó ninguna prueba`);
  if (part.correctas !== part.pruebas) bad.push(`${file}: solo ${part.correctas} de ${part.pruebas} pruebas pasaron`);
  // Archivos de prueba que han omitido todas sus pruebas (suite opt-in sin su variable de entorno).
  const skipped = (r.testResults ?? []).filter((f) => (f.assertionResults ?? []).length > 0 && f.assertionResults.every((a) => a.status === "pending" || a.status === "skipped")).map((f) => f.name);
  if (skipped.length) bad.push(`${file}: archivos totalmente omitidos: ${skipped.join(", ")}`);
}
// Entre los informes deben estar TODOS los archivos de prueba, cada uno una sola vez: ninguna prueba queda fuera.
const missing = [...expected].filter((f) => !seen.has(f));
const extra = [...seen.keys()].filter((f) => !expected.has(f));
const repeated = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
if (missing.length) bad.push(`archivos de prueba que no aparecen en ningún informe: ${missing.join(", ")}`);
if (extra.length) bad.push(`archivos en los informes que no existen en tests/: ${extra.join(", ")}`);
if (repeated.length) bad.push(`archivos ejecutados más de una vez: ${repeated.join(", ")}`);
console.log(`TOTAL: ${JSON.stringify(total)}`);
if (total.fallidas > 0) bad.push(`${total.fallidas} prueba(s) fallida(s)`);
if (total.omitidas > 0 || total.todo > 0) bad.push(`${total.omitidas} omitida(s) y ${total.todo} pendiente(s) (todo): se esperaba 0`);

if (bad.length) { console.error(`CI: ${bad.join("; ")}`); process.exit(1); }
console.log("CI: sin pruebas omitidas ni fallidas");
