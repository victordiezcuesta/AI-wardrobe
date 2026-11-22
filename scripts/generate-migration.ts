/**
 * Genera el SQL inicial (PostgreSQL) a partir de prisma/schema.prisma leyendo el DMMF, con las mismas
 * convenciones de nombres que Prisma Migrate. Útil donde el motor nativo de migraciones no está disponible.
 *   npx tsx scripts/generate-migration.ts > prisma/migrations/0001_init/migration.sql
 * En un entorno normal basta `npm run db:migrate`, que produce el equivalente.
 */
import { readFileSync } from "node:fs";
import { getDMMF } from "@prisma/internals";

type Field = { name: string; kind: string; type: string; isList: boolean; isRequired: boolean; isId: boolean; hasDefaultValue: boolean; default?: unknown; relationFromFields?: string[]; relationToFields?: string[]; relationOnDelete?: string; relationOnUpdate?: string; isUpdatedAt: boolean };

const q = (s: string) => `"${s}"`;
const SCALARS: Record<string, string> = { String: "TEXT", Int: "INTEGER", Float: "DOUBLE PRECISION", Boolean: "BOOLEAN", DateTime: "TIMESTAMP(3)", Json: "JSONB", BigInt: "BIGINT", Decimal: "DECIMAL(65,30)", Bytes: "BYTEA" };

async function main() {
  const dmmf = await getDMMF({ datamodel: readFileSync("prisma/schema.prisma", "utf8") });
  const { models, enums, indexes } = dmmf.datamodel as unknown as {
    models: { name: string; fields: Field[] }[]; enums: { name: string; values: { name: string }[] }[];
    indexes: { model: string; type: string; fields: { name: string }[] }[];
  };
  const enumNames = new Set(enums.map((e) => e.name));
  const out: string[] = ["-- Migración inicial generada desde prisma/schema.prisma (scripts/generate-migration.ts)\n"];

  for (const e of enums) out.push(`-- CreateEnum\nCREATE TYPE ${q(e.name)} AS ENUM (${e.values.map((v) => `'${v.name}'`).join(", ")});\n`);

  const defaultSql = (f: Field): string => {
    if (!f.hasDefaultValue) return "";
    const d = f.default as { name?: string } | string | number | boolean | unknown[] | undefined;
    if (f.isList) {
      // Prisma emite listas como TYPE[] (sin NOT NULL) con DEFAULT ARRAY[]::TYPE[] cuando el esquema declara @default([]).
      if (Array.isArray(d) && d.length === 0) return ` DEFAULT ARRAY[]::${enumNames.has(f.type) ? q(f.type) : SCALARS[f.type]}[]`;
      return "";
    }
    if (Array.isArray(d)) return "";
    if (typeof d === "object" && d !== null) return d.name === "now" ? " DEFAULT CURRENT_TIMESTAMP" : ""; // cuid()/uuid() los genera Prisma en la app
    if (typeof d === "string") return ` DEFAULT '${d.replace(/'/g, "''")}'`;
    if (typeof d === "number" || typeof d === "boolean") return ` DEFAULT ${d}`;
    return "";
  };

  for (const m of models) {
    const scalars = m.fields.filter((f) => f.kind === "scalar" || f.kind === "enum");
    const cols = scalars.map((f) => {
      const base = f.kind === "enum" || enumNames.has(f.type) ? q(f.type) : SCALARS[f.type];
      if (!base) throw new Error(`Tipo no soportado: ${m.name}.${f.name} (${f.type})`);
      return `    ${q(f.name)} ${base}${f.isList ? "[]" : ""}${f.isRequired && !f.isList ? " NOT NULL" : ""}${defaultSql(f)}`;
    });
    const pk = indexes.find((i) => i.model === m.name && i.type === "id");
    if (pk) cols.push(`    CONSTRAINT ${q(`${m.name}_pkey`)} PRIMARY KEY (${pk.fields.map((f) => q(f.name)).join(", ")})`);
    out.push(`-- CreateTable\nCREATE TABLE ${q(m.name)} (\n${cols.join(",\n")}\n);\n`);
  }

  for (const i of indexes.filter((x) => x.type === "unique" || x.type === "normal")) {
    const names = i.fields.map((f) => f.name);
    const unique = i.type === "unique";
    out.push(`-- Create${unique ? "Unique" : ""}Index\nCREATE ${unique ? "UNIQUE " : ""}INDEX ${q(`${i.model}_${names.join("_")}_${unique ? "key" : "idx"}`)} ON ${q(i.model)}(${names.map(q).join(", ")});\n`);
  }

  for (const m of models) {
    for (const f of m.fields.filter((x) => x.kind === "object" && x.relationFromFields?.length)) {
      const from = f.relationFromFields!, to = f.relationToFields!;
      const actions: Record<string, string> = { Cascade: "CASCADE", SetNull: "SET NULL", Restrict: "RESTRICT", NoAction: "NO ACTION" };
      const onDelete = actions[f.relationOnDelete ?? ""] ?? (f.isRequired ? "RESTRICT" : "SET NULL");
      const onUpdate = actions[f.relationOnUpdate ?? ""] ?? "CASCADE"; // sin acción explícita: CASCADE, como Prisma
      out.push(`-- AddForeignKey\nALTER TABLE ${q(m.name)} ADD CONSTRAINT ${q(`${m.name}_${from.join("_")}_fkey`)} FOREIGN KEY (${from.map(q).join(", ")}) REFERENCES ${q(f.type)}(${to.map(q).join(", ")}) ON DELETE ${onDelete} ON UPDATE ${onUpdate};\n`);
    }
  }
  process.stdout.write(out.join("\n"));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
