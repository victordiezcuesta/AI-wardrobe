import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { NextFetchEvent } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_AFTER_LOGIN, safeCallbackPath } from "@/features/authentication/callback-url";
import { LOGIN_MESSAGES, loginErrorMessage } from "@/features/authentication/login-errors";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Recorrido completo del destino tras el login, con el proxy real y Auth.js real sobre PGlite:
 * página protegida sin sesión → proxy redirige a /login?callbackUrl=… → login (Credentials) → destino.
 * El último paso reproduce lo que hace LoginForm: `router.push(safeCallbackPath(callbackUrl, location.origin))`.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));

const BASE = "http://localhost:3000";
const SECRET = "x".repeat(32);

let t: TestDb;
let proxy: (req: Request, ev: NextFetchEvent) => Promise<Response>;
let NextRequest: typeof import("next/server").NextRequest;
let Auth: typeof import("@auth/core").Auth;
let authOptions: typeof import("@/lib/auth").authOptions;

beforeAll(async () => {
  setTestEnv();
  Object.assign(process.env, { AUTH_URL: BASE, AUTH_TRUST_HOST: "true" });
  t = await startTestDb();
  holder.prisma = t.prisma;
  proxy = (await import("@/proxy")).default as unknown as typeof proxy;
  ({ NextRequest } = await import("next/server"));
  ({ Auth } = await import("@auth/core"));
  ({ authOptions } = await import("@/lib/auth"));
  await t.prisma.user.create({ data: { email: "noverif@l.com", passwordHash: await bcrypt.hash("Clave-12345", 4), profile: { create: {} } } });
}, 60_000);
afterAll(async () => { await t?.stop(); });

/** Una cuenta verificada nueva por test: el rate limit real (10 intentos / 15 min por email) no se comparte entre tests. */
let n = 0;
async function verifiedUser(): Promise<string> {
  const email = `cb${++n}@l.com`;
  await t.prisma.user.create({ data: { email, emailVerified: new Date(), passwordHash: await bcrypt.hash("Clave-12345", 4), profile: { create: {} } } });
  return email;
}

const config = () => ({ ...authOptions, secret: SECRET, basePath: "/api/auth", trustHost: true });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);

/** 1-2: el proxy redirige al login; devuelve la URL de /login con su callbackUrl. */
async function protectedVisit(pathWithQuery: string): Promise<URL> {
  const res = await proxy(new NextRequest(`${BASE}${pathWithQuery}`), {} as NextFetchEvent);
  expect(res.status).toBe(307);
  return new URL(res.headers.get("location")!);
}

/** 4-5: login como signIn("credentials", { redirect: false }) de next-auth/react. */
async function signIn(email: string, password: string, callbackUrl: string) {
  const csrfRes = await Auth(new Request(`${BASE}/api/auth/csrf`), config());
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await Auth(new Request(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1", cookie: cookiesOf(csrfRes).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl }),
  }), config());
  const { url } = (await res.json()) as { url: string };
  const p = new URL(url).searchParams;
  return { url, error: p.get("error") ?? undefined, code: p.get("code") ?? undefined, session: cookiesOf(res).some((c) => c.startsWith("authjs.session-token=")) };
}

/** 6: lo que hace LoginForm tras el login: mensaje de error o destino validado. */
async function loginFrom(loginPage: URL, email: string, password: string) {
  const callbackUrl = loginPage.searchParams.get("callbackUrl");
  // next-auth/react usa window.location.href (la propia página de login) como callbackUrl de Auth.js
  const r = await signIn(email, password, loginPage.href);
  const message = loginErrorMessage(r);
  return { ...r, message, destination: message ? null : safeCallbackPath(callbackUrl, loginPage.origin) };
}

describe("destino tras el login", () => {
  it("el destino original (con su query) se conserva desde el proxy hasta el final del login", async () => {
    const login = await protectedVisit("/wardrobe?category=shirts");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("callbackUrl")).toBe(`${BASE}/wardrobe?category=shirts`); // absoluto: antes se ignoraba
    const r = await loginFrom(login, await verifiedUser(), "Clave-12345");
    expect(r.session).toBe(true);
    expect(r.destination).toBe("/wardrobe?category=shirts");
  });

  it.each(["/stylist?date=2026-11-19", "/profile", "/dashboard"])("%s se conserva", async (path) => {
    const r = await loginFrom(await protectedVisit(path), await verifiedUser(), "Clave-12345");
    expect(r.destination).toBe(path);
  });

  it("login directo en /login sin callbackUrl → /dashboard", async () => {
    const r = await loginFrom(new URL(`${BASE}/login`), await verifiedUser(), "Clave-12345");
    expect(r.session).toBe(true);
    expect(r.destination).toBe(DEFAULT_AFTER_LOGIN);
  });

  it.each([
    "https://evil.example/phish", "//evil.example", "///evil.example", "/\\evil.example", "javascript:alert(1)", "data:text/html,x",
  ])("callbackUrl manipulado %j → /dashboard, nunca un dominio externo", async (evil) => {
    const login = new URL(`${BASE}/login`);
    login.searchParams.set("callbackUrl", evil);
    const r = await loginFrom(login, await verifiedUser(), "Clave-12345");
    expect(r.session).toBe(true);
    expect(r.destination).toBe(DEFAULT_AFTER_LOGIN);
    expect(new URL(r.destination!, BASE).origin).toBe(BASE);
    expect(new URL(r.url).origin).toBe(BASE); // Auth.js tampoco devuelve una URL externa
  });
});

describe("errores del login (sin cambios)", () => {
  it("credenciales incorrectas: mensaje genérico y sin redirección", async () => {
    const r = await loginFrom(await protectedVisit("/wardrobe"), await verifiedUser(), "Mala-12345");
    expect([r.error, r.code, r.message, r.destination, r.session]).toEqual(["CredentialsSignin", "credentials", LOGIN_MESSAGES.invalid, null, false]);
  });

  it("cuenta no verificada: mismo mensaje genérico", async () => {
    const r = await loginFrom(await protectedVisit("/wardrobe"), "noverif@l.com", "Clave-12345");
    expect([r.message, r.destination, r.session]).toEqual([LOGIN_MESSAGES.invalid, null, false]);
  });

  it("límite superado: mensaje de espera y sin redirección", async () => {
    for (let i = 0; i < 10; i++) await signIn("rl-cb@l.com", "Mala-12345", `${BASE}/login`);
    const r = await loginFrom(await protectedVisit("/wardrobe"), "rl-cb@l.com", "Mala-12345");
    expect([r.code, r.message, r.destination]).toEqual(["rate_limited", LOGIN_MESSAGES.rateLimited, null]);
  }, 30_000);
});
