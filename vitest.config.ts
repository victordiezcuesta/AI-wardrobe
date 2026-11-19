import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // next-auth importa "next/server" sin extensión (lo resuelve el bundler de Next, no Node ESM): se procesa con Vite
    // para poder ejecutar Auth.js real en los tests de sesión.
    server: { deps: { inline: ["next-auth"] } },
  },
});
