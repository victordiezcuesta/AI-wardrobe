import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Preparación del proyecto `dom` de Vitest (jsdom; ver vitest.config.ts). Solo se carga en las pruebas `*.test.tsx`.
 *  - jest-dom añade a `expect` los comprobadores de DOM (toBeInTheDocument, toHaveFocus, toHaveAccessibleName…).
 *  - Con `globals: false` (valor del proyecto), Testing Library no registra por sí sola su limpieza automática tras cada prueba:
 *    se hace aquí para que el DOM de una prueba no se filtre a la siguiente.
 */
afterEach(() => { cleanup(); });
