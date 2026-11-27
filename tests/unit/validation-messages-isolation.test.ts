import { describe, expect, it } from "vitest";

/**
 * Fase D — aislamiento: este archivo NO importa estáticamente nada del proyecto. Cada archivo de pruebas corre en su propio proceso,
 * así que aquí Zod empieza sin configurar: usa su texto por defecto (inglés). Al cargar `lib/errors` (el módulo que importan todas
 * las rutas mediante handler) la instancia queda en español. Si alguna configuración residual de otro archivo se filtrara, la
 * primera comprobación fallaría.
 */
describe("la configuración de mensajes no depende de otros archivos de pruebas", () => {
  it("antes de cargar el proyecto Zod habla inglés; tras cargar lib/errors, español", async () => {
    const { z } = await import("zod");
    const before = z.string().safeParse(1);
    expect(before.success ? "" : before.error.issues[0]!.message).toMatch(/expected string/i);
    await import("@/lib/errors");
    const after = z.string().safeParse(1);
    expect(after.success ? "" : after.error.issues[0]!.message).toBe("Debe ser un texto");
  });
});
