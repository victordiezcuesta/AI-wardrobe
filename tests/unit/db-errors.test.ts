import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { dbFailure, isDbError, safeDbError } from "@/lib/errors/db";
import { AppError } from "@/lib/errors";

/** Saneado de errores de base de datos: solo el código; los demás errores, intactos. */
const SECRET = 'publicId "ai-wardrobe/user-123/personal/p1"';

describe("isDbError / dbFailure / safeDbError", () => {
  it.each([
    ["PrismaClientKnownRequestError", new Prisma.PrismaClientKnownRequestError(SECRET, { code: "P2025", clientVersion: "t" }), "Fallo de base de datos (P2025)"],
    ["PrismaClientValidationError (sin code)", new Prisma.PrismaClientValidationError(SECRET, { clientVersion: "t" }), "Fallo de base de datos"],
    ["PrismaClientUnknownRequestError", new Prisma.PrismaClientUnknownRequestError(SECRET, { clientVersion: "t" }), "Fallo de base de datos"],
    ["PrismaClientInitializationError", new Prisma.PrismaClientInitializationError(SECRET, "t", "P1001"), "Fallo de base de datos (P1001)"],
    ["error del adaptador con code Pxxxx", Object.assign(new Error(SECRET), { code: "P1017" }), "Fallo de base de datos (P1017)"],
    ["DriverAdapterError", Object.assign(new Error(SECRET), { name: "DriverAdapterError" }), "Fallo de base de datos"],
  ])("%s → se sanea sin el mensaje original", (_n, err, expected) => {
    expect(isDbError(err)).toBe(true);
    const safe = safeDbError(err) as Error;
    expect(safe.message).toBe(expected);
    expect(safe.message).not.toContain("user-123");
    expect(safe.stack ?? "").not.toContain("user-123");
  });

  it.each([
    ["AppError de negocio", new AppError("Máximo 10 fotos personales", 422, "PHOTO_LIMIT")],
    ["error del proveedor", Object.assign(new Error("No se ha podido borrar la imagen."), { code: "IMAGE_DELETE_FAILED" })],
    ["error de red", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["error de programación", new TypeError("Cannot read properties of undefined")],
  ])("%s → NO es de base de datos: se devuelve intacto (conserva su diagnóstico)", (_n, err) => {
    expect(isDbError(err)).toBe(false);
    expect(safeDbError(err)).toBe(err);
  });

  it("dbFailure no copia códigos con formato inesperado (podrían llevar datos)", () => {
    expect(dbFailure(Object.assign(new Error("x"), { code: 'P2002 "user-123"' })).message).toBe("Fallo de base de datos");
    expect(dbFailure(null).message).toBe("Fallo de base de datos");
  });
});
