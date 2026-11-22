import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Migraciones Prisma del proyecto para las bases de datos de prueba (PGlite y el PostgreSQL local de pg-concurrency).
 *
 * Descubrimiento: cada SUBDIRECTORIO de `prisma/migrations` es una migración y debe contener un `migration.sql` no vacío
 * (los archivos sueltos, como `migration_lock.toml`, se ignoran). Orden: el mismo que Prisma Migrate, por nombre de
 * directorio en orden lexicográfico (comparación de código, independiente del idioma del sistema): `0001_…` < `0002_…`, y
 * los prefijos con marca de tiempo (`20260101120000_…`) también quedan en orden cronológico. Sin variables de entorno ni
 * conexiones: solo lee archivos del repositorio.
 */
export interface Migration { name: string; sql: string }

export const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");
/** Prefijo numérico (`0001`, marca de tiempo…) + `_` + nombre: el formato que genera Prisma y el de `0001_init`. */
const MIGRATION_NAME = /^\d+_[A-Za-z0-9_-]+$/;

/** Lista las migraciones en orden de aplicación. Lanza ante cualquier anomalía: nunca devuelve una lista parcial. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const names = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory());
  const migrations = names.map((name) => {
    if (!MIGRATION_NAME.test(name)) throw new Error(`Directorio de migración con nombre no válido: ${name}`);
    const file = path.join(dir, name, "migration.sql");
    let sql: string;
    try { sql = readFileSync(file, "utf8"); } catch { throw new Error(`La migración ${name} no tiene migration.sql`); }
    if (sql.trim() === "") throw new Error(`La migración ${name} está vacía`);
    return { name, sql };
  });
  if (migrations.length === 0) throw new Error(`No hay migraciones en ${dir}`);
  return migrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Cualquier destino capaz de ejecutar un script SQL con varias sentencias (PGlite.exec, pg.Client.query). */
export type SqlTarget = (sql: string) => Promise<unknown>;

/**
 * Aplica las migraciones UNA vez cada una y en el orden recibido. Si una falla, se detiene en ella (las siguientes no se
 * ejecutan) y lanza un error con su nombre y la causa original. Nombres repetidos → error antes de ejecutar nada.
 * Devuelve los nombres aplicados, en orden.
 */
export async function applyMigrations(run: SqlTarget, migrations: readonly Migration[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.name)) throw new Error(`Migración duplicada: ${m.name}`);
    seen.add(m.name);
  }
  const applied: string[] = [];
  for (const m of migrations) {
    try {
      await run(m.sql);
    } catch (cause) {
      throw new Error(`La migración ${m.name} falló (aplicadas antes: ${applied.join(", ") || "ninguna"})`, { cause });
    }
    applied.push(m.name);
  }
  return applied;
}
