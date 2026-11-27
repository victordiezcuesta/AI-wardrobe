import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Dos proyectos de Vitest que comparten esta configuración raíz (alias «@» y `server.deps`; los proyectos en línea la heredan):
 *  - `node` (entorno Node): TODAS las pruebas existentes, `tests/**\/*.test.ts` (unitarias, integración, PGlite…). No cambia nada
 *    respecto a antes: mismo entorno, mismos archivos, sin setup adicional.
 *  - `dom` (entorno jsdom): pruebas de componentes React y de interacción, `tests/**\/*.test.tsx`, con React Testing Library,
 *    user-event y jest-dom (ver tests/setup/dom.ts). La separación es por extensión: un archivo `.test.tsx` es una prueba de DOM y
 *    un `.test.ts` es una prueba de Node. jest-dom y jsdom solo se cargan en este proyecto.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // next-auth importa "next/server" sin extensión (lo resuelve el bundler de Next, no Node ESM): se procesa con Vite
    // para poder ejecutar Auth.js real en los tests de sesión.
    server: { deps: { inline: ["next-auth"] } },
    projects: [
      { test: { name: "node", environment: "node", include: ["tests/**/*.test.ts"] } },
      { test: { name: "dom", environment: "jsdom", include: ["tests/**/*.test.tsx"], setupFiles: ["./tests/setup/dom.ts"] } },
    ],
  },
});
