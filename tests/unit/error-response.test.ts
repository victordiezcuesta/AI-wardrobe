import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";

/**
 * Manejador global de errores (`toResponse` / `handler`): los errores de base de datos se registran saneados (solo su
 * código: Prisma puede repetir en el mensaje argumentos de la consulta, como ids o publicId); el resto, completos.
 * Las respuestas HTTP no cambian. Incluye una ruta de borrado real con el servicio simulado (sin base de datos).
 */
const svc = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUserId: async () => "user-cmi8k2wzz0000gh78ij90kl12" }));
vi.mock("@/services/wardrobe.service", () => ({ wardrobeService: { remove: svc.remove } }));

import { AppError, handler, toResponse } from "@/lib/errors";

const USER_ID = "user-cmi8k2wzz0000gh78ij90kl12";
const PUBLIC_ID = `ai-wardrobe/${USER_ID}/wardrobe/img-secreta`;
const SENSITIVE = [USER_ID, PUBLIC_ID, "img-secreta", "Invalid `prisma"];

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, "error").mockImplementation(() => undefined); svc.remove.mockReset(); });
afterEach(() => { spy.mockRestore(); });
/** Entradas de log (logError escribe un JSON por llamada). */
const logs = () => (spy.mock.calls as unknown[][]).map((c) => JSON.parse(String(c[0])) as { level: string; scope: string; message: string; stack?: string[] });
const rawLogs = () => spy.mock.calls.flat().map(String).join("\n");

const known = () => new Prisma.PrismaClientKnownRequestError(
  `Invalid \`prisma.wardrobeItem.deleteMany()\` invocation: { where: { id: "it1", userId: "${USER_ID}", imagePublicId: "${PUBLIC_ID}" } } Record to delete does not exist.`,
  { code: "P2025", clientVersion: "test" },
);
const validation = () => new Prisma.PrismaClientValidationError(
  `Invalid \`prisma.userProfile.update()\` invocation:\n{ where: { userId: "${USER_ID}" }, data: { photoPublicIds: ["${PUBLIC_ID}"] } }\nArgument \`data\` is missing.`,
  { clientVersion: "test" },
);
const adapter = () => Object.assign(new Error(`Can't reach database server (user ${USER_ID})`), { code: "P1001" });

async function expectInternal(res: Response) {
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "Error interno" } }); // respuesta sin cambios
}

describe("toResponse: errores de base de datos → log saneado, misma respuesta", () => {
  it.each([
    ["PrismaClientKnownRequestError", known, "Fallo de base de datos (P2025)"],
    ["PrismaClientValidationError (sin código)", validation, "Fallo de base de datos"],
    ["error del adaptador con código Pxxxx", adapter, "Fallo de base de datos (P1001)"],
  ])("%s → se registra solo el código; ni ids, ni publicId, ni la consulta", async (_n, make, expected) => {
    await expectInternal(toResponse("wardrobe.delete", make()));
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({ level: "error", scope: "wardrobe.delete", message: expected });
    for (const s of SENSITIVE) expect(rawLogs()).not.toContain(s); // tampoco en la traza
  });
});

describe("toResponse: el resto de errores conserva su comportamiento", () => {
  it("error de aplicación que no es de base de datos → se registra completo (mensaje y traza), misma respuesta 500", async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'imagePublicId')");
    await expectInternal(toResponse("photos.delete", bug));
    expect(logs()).toHaveLength(1);
    expect(logs()[0]!.message).toBe(bug.message);
    expect(logs()[0]!.stack?.[0]).toContain("TypeError: Cannot read properties of undefined");
  });

  it("valor lanzado que no es un Error → se registra como antes (String(valor))", async () => {
    await expectInternal(toResponse("x", "algo raro"));
    expect(logs()[0]!.message).toBe("algo raro");
  });

  it("AppError → misma respuesta (estado, código y mensaje) y no se registra", async () => {
    const res = toResponse("x", new AppError("Prenda no encontrada", 404, "NOT_FOUND"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Prenda no encontrada" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ZodError → misma respuesta 422 con sus issues y no se registra", async () => {
    const parsed = z.object({ publicId: z.string().min(1) }).safeParse({ publicId: "" });
    const res = toResponse("x", parsed.error);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION", message: "Datos no válidos", issues: [{ path: "publicId" }] } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("handler y ruta de borrado real", () => {
  it("handler(): un error de Prisma lanzado por la función → 500 genérico y log saneado", async () => {
    const res = await handler("wardrobe.delete", async () => { throw known(); })();
    await expectInternal(res);
    expect(logs()[0]).toMatchObject({ scope: "wardrobe.delete", message: "Fallo de base de datos (P2025)" });
    for (const s of SENSITIVE) expect(rawLogs()).not.toContain(s);
  });

  it("DELETE /api/wardrobe/[id]: el servicio falla con un error de Prisma → 500 genérico; el log no contiene ids ni publicId", async () => {
    svc.remove.mockRejectedValue(validation());
    const { DELETE } = await import("@/app/api/wardrobe/[id]/route");
    const res = await DELETE(new Request("http://localhost:3000/api/wardrobe/it1", { method: "DELETE" }), { params: Promise.resolve({ id: "it1" }) });
    await expectInternal(res);
    expect(svc.remove).toHaveBeenCalledWith(USER_ID, "it1");
    expect(logs()[0]).toMatchObject({ scope: "wardrobe.delete", message: "Fallo de base de datos" });
    for (const s of SENSITIVE) expect(rawLogs()).not.toContain(s);
  });

  it("DELETE /api/wardrobe/[id]: un error de negocio (AppError) se devuelve igual que antes", async () => {
    svc.remove.mockRejectedValue(new AppError("Prenda no encontrada", 404, "NOT_FOUND"));
    const { DELETE } = await import("@/app/api/wardrobe/[id]/route");
    const res = await DELETE(new Request("http://localhost:3000/api/wardrobe/x", { method: "DELETE" }), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Prenda no encontrada" } });
  });
});
