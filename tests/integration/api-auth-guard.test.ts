import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFetchEvent } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Protección de rutas sin sesión: el proxy real (src/proxy.ts, next-auth + authConfig) y los Route Handlers reales
 * sobre PGlite. Solo se simula `next/headers` (no existe fuera de Next) para que `auth()` lea la cookie de la petición.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const req = vi.hoisted(() => ({ cookie: "" }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: req.cookie, host: "localhost:3000", "x-forwarded-proto": "http" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
}));

const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token";
const SECRET = "x".repeat(32);

let t: TestDb;
let proxy: (req: Request, ev: NextFetchEvent) => Promise<Response>;
let matcher: string;
let NextRequest: typeof import("next/server").NextRequest;
let encode: typeof import("@auth/core/jwt").encode;

beforeAll(async () => {
  setTestEnv();
  Object.assign(process.env, { AUTH_URL: BASE, AUTH_TRUST_HOST: "true" });
  t = await startTestDb();
  holder.prisma = t.prisma;
  const mod = await import("@/proxy");
  proxy = mod.default as unknown as typeof proxy;
  matcher = mod.config.matcher[0]!;
  ({ NextRequest } = await import("next/server"));
  ({ encode } = await import("@auth/core/jwt"));
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(() => { req.cookie = ""; });

const runProxy = (path: string, cookie?: string) =>
  proxy(new NextRequest(`${BASE}${path}`, { headers: cookie ? { cookie } : {} }), {} as NextFetchEvent);
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
/** ¿Aplica Next el proxy a esta ruta? Mismo patrón que `config.matcher` (expresión regular anclada). */
const proxied = (path: string) => new RegExp(`^${matcher}$`).test(path);

async function sessionCookie(email: string) {
  const { sessionService } = await import("@/services/session.service");
  const u = await t.prisma.user.create({ data: { email, emailVerified: new Date(), passwordHash: "x", profile: { create: { onboardingDone: true } } } });
  const sid = await sessionService.start(u.id);
  const jwt = await encode({ token: { sub: u.id, email, sid }, secret: SECRET, salt: COOKIE, maxAge: 14 * 86400 });
  return { userId: u.id, sid, cookie: `${COOKIE}=${jwt}` };
}

async function wardrobeHandler(cookie: string) {
  req.cookie = cookie;
  const { GET } = await import("@/app/api/wardrobe/route");
  return GET(new Request(`${BASE}/api/wardrobe`, { headers: { cookie } }));
}

describe("sin sesión", () => {
  it("una API protegida responde 401 JSON (no 307 ni HTML), con no-store", async () => {
    for (const path of ["/api/wardrobe", "/api/profile", "/api/outfits", "/api/try-on"]) {
      expect(proxied(path)).toBe(true);
      const res = await runProxy(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "No autenticado" } });
    }
  });

  it("también para métodos de escritura", async () => {
    const res = await proxy(new NextRequest(`${BASE}/api/wardrobe`, { method: "POST", body: "{}" }), {} as NextFetchEvent);
    expect(res.status).toBe(401);
  });

  it("una página protegida sigue redirigiendo a /login con callbackUrl", async () => {
    for (const path of ["/dashboard", "/wardrobe", "/profile", "/onboarding"]) {
      const res = await runProxy(path);
      expect(res.status, path).toBe(307);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("callbackUrl")).toBe(`${BASE}${path}`);
    }
  });

  it("una ruta que no empieza por /api/ (aunque contenga «api») no se trata como API", async () => {
    const res = await runProxy("/apiary");
    expect(res.status).toBe(307);
  });
});

describe("rutas públicas", () => {
  it("las páginas públicas pasan sin sesión", async () => {
    for (const path of ["/", "/login", "/register", "/forgot-password", "/reset-password", "/verify-email"]) {
      expect(passedThrough(await runProxy(path)), path).toBe(true);
    }
  });

  it("las APIs públicas quedan fuera del proxy", () => {
    for (const path of ["/api/auth/session", "/api/auth/csrf", "/api/auth/callback/credentials", "/api/auth/logout", "/api/auth/register", "/api/health", "/api/cron/catalog-sync"]) {
      expect(proxied(path), path).toBe(false);
    }
  });

  it("/api/health responde sin sesión", async () => {
    const { GET } = await import("@/app/api/health/route");
    expect((await GET()).status).toBe(200);
  });
});

describe("con sesión", () => {
  it("una sesión válida pasa el proxy y la API funciona", async () => {
    const s = await sessionCookie("valida@g.com");
    expect(passedThrough(await runProxy("/api/wardrobe", s.cookie))).toBe(true);
    expect(passedThrough(await runProxy("/dashboard", s.cookie))).toBe(true);
    const res = await wardrobeHandler(s.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("una sesión revocada pasa el proxy (no consulta Neon) pero la API responde el MISMO 401 JSON", async () => {
    const s = await sessionCookie("revocada@g.com");
    const { sessionService } = await import("@/services/session.service");
    await sessionService.revoke(s.sid);

    expect(passedThrough(await runProxy("/api/wardrobe", s.cookie))).toBe(true);
    const fromHandler = await wardrobeHandler(s.cookie);
    expect(fromHandler.status).toBe(401);
    const fromProxy = await runProxy("/api/wardrobe");
    expect(await fromHandler.json()).toEqual(await fromProxy.json());
  });
});

describe("formato de error", () => {
  it("el 401 del proxy es idéntico al que genera el sistema de errores (toResponse(unauthorized()))", async () => {
    const { toResponse, unauthorized } = await import("@/lib/errors");
    const { apiUnauthorizedResponse } = await import("@/lib/auth/config");
    const expected = toResponse("test", unauthorized());
    const actual = apiUnauthorizedResponse();
    expect(actual.status).toBe(expected.status);
    expect(await actual.json()).toEqual(await expected.json());
  });
});
