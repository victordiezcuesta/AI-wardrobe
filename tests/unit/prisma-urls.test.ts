import { describe, expect, it } from "vitest";
import { APP_POOL_OPTIONS } from "@/lib/prisma";
import { isPoolerUrl, migrationUrl } from "@/lib/prisma/migration-url";

const POOLED = "postgresql://u:p@ep-cool-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require";
const DIRECT = "postgresql://u:p@ep-cool-123456.eu-central-1.aws.neon.tech/db?sslmode=require";

describe("URL de migraciones (conexión directa, nunca el pooler)", () => {
  it("reconoce el host del pooler de Neon y no confunde otros", () => {
    expect(isPoolerUrl(POOLED)).toBe(true);
    expect(isPoolerUrl(DIRECT)).toBe(false);
    expect(isPoolerUrl("postgresql://u@my-pooler-notes.example.com/db")).toBe(false);
    expect(isPoolerUrl("no es una url")).toBe(false);
  });
  it("prefiere DIRECT_URL", () => expect(migrationUrl({ DIRECT_URL: DIRECT, DATABASE_URL: POOLED })).toBe(DIRECT));
  it("usa DATABASE_URL solo si no es del pooler", () => {
    expect(migrationUrl({ DATABASE_URL: DIRECT })).toBe(DIRECT);
    expect(migrationUrl({ DATABASE_URL: "postgresql://postgres@localhost:5432/dev" })).toBe("postgresql://postgres@localhost:5432/dev");
  });
  it("rechaza un DIRECT_URL que apunta al pooler (no migra por PgBouncer aunque esté mal configurado)", () => {
    expect(migrationUrl({ DIRECT_URL: POOLED, DATABASE_URL: POOLED })).toBe("postgresql://localhost:5432/placeholder");
    // Con DIRECT_URL del pooler, DATABASE_URL directa sí es una alternativa válida.
    expect(migrationUrl({ DIRECT_URL: POOLED, DATABASE_URL: DIRECT })).toBe(DIRECT);
  });
  it("no migra por el pooler: sin DIRECT_URL devuelve el marcador", () => {
    expect(migrationUrl({ DATABASE_URL: POOLED })).toBe("postgresql://localhost:5432/placeholder");
    expect(migrationUrl({})).toBe("postgresql://localhost:5432/placeholder");
  });
});

describe("pool de la app", () => {
  it("acota la espera de conexión (sin él, una conexión colgada bloquea la petición indefinidamente)", () => {
    expect(APP_POOL_OPTIONS.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(APP_POOL_OPTIONS.connectionTimeoutMillis).toBeLessThanOrEqual(30_000);
  });
});
