import { describe, expect, it } from "vitest";
import { isUniqueViolationOn, type UniqueConstraintRef } from "@/lib/errors/db";

/**
 * Fase F.3 — identificación inequívoca de la violación de la restricción única del EMAIL. Las formas del error son las reales de Prisma 7
 * con adaptadores de driver: `meta.driverAdapterError.cause = { kind, constraint, table }`, con `constraint = { index }` (adaptador pg;
 * forma observada con PGlite) o `{ fields }` (adaptador de Neon, ver node_modules/@prisma/adapter-neon). No se interpretan mensajes.
 */
const EMAIL: UniqueConstraintRef = { table: "User", fields: ["email"], index: "User_email_key" };
const p2002 = (cause: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { name: "PrismaClientKnownRequestError", code: "P2002", meta: { modelName: "User", driverAdapterError: cause === undefined ? undefined : { name: "DriverAdapterError", cause }, ...extra } });
const cause = (over: Record<string, unknown> = {}) => ({ kind: "UniqueConstraintViolation", originalCode: "23505", ...over });

describe("isUniqueViolationOn — qué SÍ es el email", () => {
  it("adaptador pg (pruebas): índice User_email_key en la tabla User", () => {
    expect(isUniqueViolationOn(p2002(cause({ constraint: { index: "User_email_key" }, table: "User" })), EMAIL)).toBe(true);
  });
  it("adaptador de Neon (producción): columnas exactamente [email], con o sin tabla informada", () => {
    expect(isUniqueViolationOn(p2002(cause({ constraint: { fields: ["email"] }, table: "User" })), EMAIL)).toBe(true);
    expect(isUniqueViolationOn(p2002(cause({ constraint: { fields: ["email"] } })), EMAIL)).toBe(true);
  });
  it("sin tabla informada pero con el índice exacto", () => {
    expect(isUniqueViolationOn(p2002(cause({ constraint: { index: "User_email_key" } })), EMAIL)).toBe(true);
  });
});

describe("isUniqueViolationOn — qué NO se confunde con el email (el error no se oculta)", () => {
  it.each([
    ["otra restricción única (perfil)", cause({ constraint: { index: "UserProfile_userId_key" }, table: "UserProfile" })],
    ["clave primaria de User", cause({ constraint: { index: "User_pkey" }, table: "User" })],
    ["columnas distintas (userId)", cause({ constraint: { fields: ["userId"] }, table: "UserProfile" })],
    ["columnas distintas (id)", cause({ constraint: { fields: ["id"] }, table: "User" })],
    ["email junto a otra columna", cause({ constraint: { fields: ["email", "id"] }, table: "User" })],
    ["otra columna primero", cause({ constraint: { fields: ["id", "email"] }, table: "User" })],
    ["campos vacíos", cause({ constraint: { fields: [] }, table: "User" })],
    ["campos con tipo incorrecto", cause({ constraint: { fields: "email" }, table: "User" })],
    ["campos con elementos que no son texto", cause({ constraint: { fields: [{ toString: (): string => "email" }] }, table: "User" })],
    ["índice parecido", cause({ constraint: { index: "User_email_key2" }, table: "User" })],
    ["índice en minúsculas", cause({ constraint: { index: "user_email_key" }, table: "User" })],
    ["índice que contiene el nombre", cause({ constraint: { index: "xUser_email_key" }, table: "User" })],
    ["el índice correcto pero en otra tabla", cause({ constraint: { index: "User_email_key" }, table: "Account" })],
    ["columnas correctas pero en otra tabla", cause({ constraint: { fields: ["email"] }, table: "Other" })],
    ["índice correcto con columnas incorrectas: manda el índice", cause({ constraint: { index: "User_pkey", fields: ["email"] }, table: "User" })],
    ["sin información de la restricción (p. ej. servidor localizado en Neon)", cause({ table: "User" })],
    ["restricción vacía", cause({ constraint: {}, table: "User" })],
    ["restricción que no es un objeto", cause({ constraint: "User_email_key", table: "User" })],
    ["otro tipo de error del adaptador", { kind: "ForeignKeyConstraintViolation", constraint: { index: "User_email_key" }, table: "User" }],
    ["sin tipo", { constraint: { index: "User_email_key" }, table: "User" }],
  ])("%s → false", (_n, c) => {
    expect(isUniqueViolationOn(p2002(c as Record<string, unknown>), EMAIL)).toBe(false);
  });

  it("sin causa del adaptador (o sin meta): false", () => {
    expect(isUniqueViolationOn(p2002(undefined), EMAIL)).toBe(false);
    expect(isUniqueViolationOn(Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2002" }), EMAIL)).toBe(false);
    expect(isUniqueViolationOn(Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2002", meta: { target: ["email"] } }), EMAIL)).toBe(false); // `meta.target` (motor clásico) no se admite
  });

  it("otros códigos de Prisma con la misma forma (P2003, P2025, P1001): false", () => {
    for (const code of ["P2003", "P2025", "P1001", "P2024"]) {
      const err = Object.assign(p2002(cause({ constraint: { index: "User_email_key" }, table: "User" })), { code });
      expect(isUniqueViolationOn(err, EMAIL), code).toBe(false);
    }
  });

  it("el mensaje no cuenta: un error que NO es de Prisma con el texto de un P2002 de email, o con la forma pero sin ser un error de base de datos, es false", () => {
    expect(isUniqueViolationOn(new Error("Unique constraint failed on the fields: (`email`) P2002"), EMAIL)).toBe(false);
    expect(isUniqueViolationOn({ code: "P2002", meta: { driverAdapterError: { cause: cause({ constraint: { index: "User_email_key" }, table: "User" }) } } }, EMAIL)).toBe(true); // con code Pxxxx se considera error de BD (isDbError); la forma exacta decide
    expect(isUniqueViolationOn(Object.assign(new Error("x"), { name: "TypeError", meta: { driverAdapterError: { cause: cause({ constraint: { index: "User_email_key" }, table: "User" }) } } }), EMAIL)).toBe(false);
  });

  it.each([[null], [undefined], ["P2002"], [42], [true], [{}], [[]]])("entrada que no es un error (%s) → false", (v) => {
    expect(isUniqueViolationOn(v, EMAIL)).toBe(false);
  });

  it("objetos manipulados (getters que lanzan, Proxy hostil) no lanzan y dan false", () => {
    const hostile = new Proxy({}, { get() { throw new Error("secreto"); } });
    expect(() => isUniqueViolationOn(hostile, EMAIL)).not.toThrow();
    expect(isUniqueViolationOn(hostile, EMAIL)).toBe(false);
    const err = Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2002" });
    Object.defineProperty(err, "meta", { get() { throw new Error("secreto"); } });
    expect(() => isUniqueViolationOn(err, EMAIL)).not.toThrow();
    expect(isUniqueViolationOn(err, EMAIL)).toBe(false);
    const deep = p2002(cause({ table: "User" }));
    Object.defineProperty((deep.meta as { driverAdapterError: object }).driverAdapterError, "cause", { get() { throw new Error("secreto"); } });
    expect(isUniqueViolationOn(deep, EMAIL)).toBe(false);
  });
});
