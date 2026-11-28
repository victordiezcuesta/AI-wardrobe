import "dotenv/config";
import { defineConfig } from "prisma/config";
import { migrationUrl } from "./src/lib/prisma/migration-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Conexión DIRECTA (sin pooler) para migraciones: DIRECT_URL, o DATABASE_URL solo si no es del pooler.
    url: migrationUrl(),
  },
});
