import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * PUT /api/profile real (Route Handler → Zod → servicio → repositorio → Prisma sobre PGlite), con sesión real.
 * Solo se simula `next/headers` (no existe fuera de Next) para que `auth()` lea la cookie.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const req = vi.hoisted(() => ({ cookie: "" }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: req.cookie, host: "localhost:3000", "x-forwarded-proto": "http" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
}));

const BASE = "http://localhost:3000";
const SECRET = "x".repeat(32);
const FULL = {
  name: "Ana", age: 30, heightCm: 170, presentation: "femenina",
  usualStyles: ["casual", "minimalista"], exploreStyles: ["smart casual"],
  favoriteColors: ["azul marino", "blanco"], avoidedColors: ["naranja"], favoriteBrands: ["Mango"],
  budgetMin: 20, budgetMax: 120, sizes: { top: "M", bottom: "40", shoes: "38" }, fitPreference: "regular",
  homeCity: "Madrid", homeLat: 40.4168, homeLon: -3.7038, favoriteGarments: ["vaqueros"], onboardingDone: true,
};

let t: TestDb;
let route: typeof import("@/app/api/profile/route");

beforeAll(async () => {
  setTestEnv();
  Object.assign(process.env, { AUTH_URL: BASE, AUTH_TRUST_HOST: "true" });
  t = await startTestDb();
  holder.prisma = t.prisma;
  route = await import("@/app/api/profile/route");
}, 60_000);
afterAll(async () => { await t?.stop(); });

/** Usuario como lo crea el registro (perfil vacío) o sin fila de perfil (cuentas antiguas), con sesión válida. */
async function login(email: string, opts: { withProfile?: boolean } = {}) {
  const { sessionService } = await import("@/services/session.service");
  const { encode } = await import("@auth/core/jwt");
  const u = await t.prisma.user.create({ data: { email, name: "Inicial", passwordHash: "x", ...(opts.withProfile !== false && { profile: { create: {} } }) } });
  const sid = await sessionService.start(u.id);
  req.cookie = `authjs.session-token=${await encode({ token: { sub: u.id, sid }, secret: SECRET, salt: "authjs.session-token", maxAge: 3600 })}`;
  return u.id;
}
async function put(body: unknown) {
  const res = await route.PUT(new Request(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json", cookie: req.cookie }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { profile?: Record<string, unknown>; error?: { code: string } } };
}
const stored = (userId: string) => t.prisma.userProfile.findUniqueOrThrow({ where: { userId } });
/** Todo el perfil menos los campos que cambian solos. */
const snapshot = async (userId: string) => {
  const { updatedAt: _u, createdAt: _c, id: _i, ...rest } = await stored(userId);
  return rest;
};

let userId: string;
beforeEach(async () => {
  userId = await login(`p${Math.random().toString(36).slice(2)}@p.com`);
  expect((await put(FULL)).status).toBe(200);
});

describe("actualización parcial", () => {
  it("actualizar un único campo no modifica los demás", async () => {
    const before = await snapshot(userId);
    const r = await put({ homeCity: "Bilbao" });
    expect(r.status).toBe(200);
    expect(await snapshot(userId)).toEqual({ ...before, homeCity: "Bilbao" });
    expect(r.body.profile?.usualStyles).toEqual(["casual", "minimalista"]); // la respuesta refleja lo guardado
  });

  it("omitir las listas conserva su contenido", async () => {
    await put({ age: 31 });
    const p = await stored(userId);
    expect(p.usualStyles).toEqual(["casual", "minimalista"]);
    expect(p.exploreStyles).toEqual(["smart casual"]);
    expect(p.favoriteColors).toEqual(["azul marino", "blanco"]);
    expect(p.avoidedColors).toEqual(["naranja"]);
    expect(p.favoriteBrands).toEqual(["Mango"]);
    expect(p.favoriteGarments).toEqual(["vaqueros"]);
    expect(p.age).toBe(31);
  });

  it("enviar [] explícito vacía solo esa lista", async () => {
    const before = await snapshot(userId);
    await put({ favoriteBrands: [] });
    expect(await snapshot(userId)).toEqual({ ...before, favoriteBrands: [] });
  });

  it("enviar una lista con elementos la sustituye", async () => {
    await put({ favoriteColors: ["verde"] });
    const p = await stored(userId);
    expect(p.favoriteColors).toEqual(["verde"]);
    expect(p.avoidedColors).toEqual(["naranja"]);
  });

  it("valores inválidos → 422 y nada cambia", async () => {
    const before = await snapshot(userId);
    for (const body of [{ age: 5 }, { usualStyles: [""] }, { favoriteColors: null }, { budgetMin: 200, budgetMax: 50 }, { homeLat: 999 }]) {
      const r = await put(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.error?.code).toBe("VALIDATION");
    }
    expect(await snapshot(userId)).toEqual(before);
  });

  it("null conserva su semántica: borra el campo; omitirlo lo mantiene", async () => {
    await put({ age: null, homeCity: null, homeLat: null, homeLon: null });
    const p = await stored(userId);
    expect([p.age, p.homeCity, p.homeLat, p.homeLon]).toEqual([null, null, null, null]);
    expect(p.heightCm).toBe(170); // omitido: intacto
    expect(p.budgetMin).toBe(20);
  });

  it("el nombre (en User) solo cambia si se envía", async () => {
    await put({ age: 40 });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: userId } })).name).toBe("Ana");
    await put({ name: "Ana María" });
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: userId } })).name).toBe("Ana María");
  });

  it("«omitir» en el onboarding ({ onboardingDone: true }) no borra nada", async () => {
    const before = await snapshot(userId);
    await put({ onboardingDone: true });
    expect(await snapshot(userId)).toEqual(before);
  });
});

describe("creación y flujo completo", () => {
  it("el perfil creado en el registro tiene listas vacías y el onboarding completo lo rellena", async () => {
    const id = await login("registro@p.com");
    const fresh = await stored(id);
    expect([fresh.usualStyles, fresh.favoriteGarments, fresh.onboardingDone]).toEqual([[], [], false]);
    await put(FULL);
    const p = await stored(id);
    expect(p.usualStyles).toEqual(FULL.usualStyles);
    expect(p.onboardingDone).toBe(true);
  });

  it("cuenta sin fila de perfil: un PUT parcial lo crea con listas vacías por defecto (base de datos)", async () => {
    const id = await login("sinperfil@p.com", { withProfile: false });
    expect(await t.prisma.userProfile.findUnique({ where: { userId: id } })).toBeNull();
    const r = await put({ homeCity: "Valencia" });
    expect(r.status).toBe(200);
    const p = await stored(id);
    expect(p.homeCity).toBe("Valencia");
    expect([p.usualStyles, p.favoriteColors, p.favoriteGarments]).toEqual([[], [], []]);
    expect(p.onboardingDone).toBe(false);
  });

  it("edición completa desde el formulario (todas las listas) sigue funcionando", async () => {
    const edit = { ...FULL, usualStyles: ["formal"], exploreStyles: [], favoriteGarments: ["blazer"], homeCity: "Sevilla" };
    await put(edit);
    const p = await stored(userId);
    expect([p.usualStyles, p.exploreStyles, p.favoriteGarments, p.homeCity]).toEqual([["formal"], [], ["blazer"], "Sevilla"]);
  });
});
