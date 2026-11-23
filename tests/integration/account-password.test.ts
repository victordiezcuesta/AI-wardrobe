import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 20.3b — POST /api/account/password con el Route Handler REAL, Auth.js real (JWT y cookies cifrados de verdad), Prisma
 * real sobre PGlite, `requireUserId` real, el servicio y el limitador reales. Solo se simulan `next/headers` (para que `auth()`
 * lea la cookie de la «petición») y un envoltorio sobre `rateLimit` que registra las llamadas e inyecta fallos de almacenamiento.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const req = vi.hoisted(() => ({ cookie: "" }));
const lim = vi.hoisted(() => ({ keys: [] as string[], failAccountPassword: false }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: req.cookie, host: "localhost:3000", "x-forwarded-proto": "http" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/rate-limit")>();
  return {
    ...real,
    rateLimit: async (key: string, limit: number, windowSec: number) => {
      lim.keys.push(`${key}|${limit}|${windowSec}`);
      if (lim.failAccountPassword && key.startsWith("account-password:")) throw new Error("fallo de almacenamiento simulado");
      return real.rateLimit(key, limit, windowSec);
    },
  };
});

const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token";
const SECRET = "x".repeat(32);
const PASS = "Clave-12345";
const NEW = "NuevaClave-789";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

let t: TestDb;
let Auth: typeof import("@auth/core").Auth;
let authOptions: typeof import("@/lib/auth").authOptions;
let encode: typeof import("@auth/core/jwt").encode;
let decode: typeof import("@auth/core/jwt").decode;
let POST: (req: Request) => Promise<Response>;
let hashSpy: ReturnType<typeof vi.spyOn>;
let compareSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  setTestEnv();
  Object.assign(process.env, { AUTH_URL: BASE, AUTH_TRUST_HOST: "true" });
  t = await startTestDb(); holder.prisma = t.prisma;
  ({ Auth } = await import("@auth/core"));
  ({ authOptions } = await import("@/lib/auth"));
  ({ encode, decode } = await import("@auth/core/jwt"));
  POST = (await import("@/app/api/account/password/route")).POST;
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  req.cookie = ""; lim.keys.length = 0; lim.failAccountPassword = false;
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "RateLimit", "VerificationToken" CASCADE`);
  hashSpy = vi.spyOn(bcrypt, "hash");
  compareSpy = vi.spyOn(bcrypt, "compare");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const config = () => ({ ...authOptions, secret: SECRET, basePath: "/api/auth", trustHost: true });
const setCookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);
async function login(email: string, password: string): Promise<string | undefined> {
  const csrfRes = await Auth(new Request(`${BASE}/api/auth/csrf`), config());
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await Auth(new Request(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: setCookies(csrfRes).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/dashboard` }),
  }), config());
  return setCookies(res).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
async function getWardrobe(jwt: string): Promise<number> {
  req.cookie = `${COOKIE}=${jwt}`;
  const { GET } = await import("@/app/api/wardrobe/route");
  return (await GET(new Request(`${BASE}/api/wardrobe`, { headers: { cookie: req.cookie } }))).status;
}
async function createUser(email: string, password: string | null) {
  return t.prisma.user.create({ data: { email, name: "Test", emailVerified: new Date(), passwordHash: password === null ? null : await bcrypt.hash(password, 4), profile: { create: {} } } });
}
const sidOf = async (jwt: string) => (await decode({ token: jwt, secret: SECRET, salt: COOKIE }))?.sid as string;

interface Opts { cookieHeader?: boolean; origin?: string }
/** POST real. `req.cookie` alimenta a `auth()` (next/headers); la cabecera `cookie` de la petición, a `getToken` (sid). */
async function change(jwt: string | null, body: unknown, o: Opts = {}) {
  req.cookie = jwt ? `${COOKIE}=${jwt}` : "";
  const headers: Record<string, string> = { "content-type": "application/json", origin: o.origin ?? BASE, host: "localhost:3000" };
  if (jwt && o.cookieHeader !== false) headers.cookie = `${COOKIE}=${jwt}`;
  const res = await POST(new Request(`${BASE}/api/account/password`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, text: await res.clone().text(), body: (await res.json()) as { ok?: boolean; error?: { code: string } } };
}
const hashOf = async (id: string) => (await t.prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
const sessions = (userId: string) => t.prisma.session.count({ where: { userId } });
const counter = async (userId: string) => (await t.prisma.rateLimit.findUnique({ where: { key: `account-password:${userId}` } }))?.count ?? 0;
const accountPasswordCalls = () => lim.keys.filter((k) => k.startsWith("account-password:"));
const session2 = async (email: string) => ({ a: (await login(email, PASS))!, b: (await login(email, PASS))! });

describe("cambio correcto", () => {
  it("guarda el hash nuevo, conserva la sesión actual y revoca las demás (incluidos los JWT ya emitidos)", async () => {
    const u = await createUser("ok@s.com", PASS);
    const { a, b } = await session2("ok@s.com");
    const c = (await login("ok@s.com", PASS))!;
    expect(await sessions(u.id)).toBe(3);
    const before = (await hashOf(u.id))!;

    const r = await change(a, { currentPassword: PASS, newPassword: NEW });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    const after = (await hashOf(u.id))!;
    expect(after).not.toBe(before);
    expect(await bcrypt.compare(NEW, after)).toBe(true);
    expect(await bcrypt.compare(PASS, after)).toBe(false);
    expect(await sessions(u.id)).toBe(1);
    expect(await t.prisma.session.findUnique({ where: { sessionToken: sha(await sidOf(a)) } })).not.toBeNull(); // la actual, intacta
    expect(await getWardrobe(a)).toBe(200);
    expect(await getWardrobe(b)).toBe(401);   // JWT copiado antes: revocado
    expect(await getWardrobe(c)).toBe(401);
    expect(await login("ok@s.com", PASS)).toBeUndefined();  // la contraseña antigua ya no entra
    expect(await login("ok@s.com", NEW)).toBeDefined();
    expect(accountPasswordCalls()).toEqual([`account-password:${u.id}|5|3600`]);
  }, 30_000);

  it("no toca las sesiones de otro usuario", async () => {
    const u = await createUser("uno@s.com", PASS);
    const o = await createUser("dos@s.com", PASS);
    const a = (await login("uno@s.com", PASS))!;
    const otro = (await login("dos@s.com", PASS))!;
    expect((await change(a, { currentPassword: PASS, newPassword: NEW })).status).toBe(200);
    expect(await sessions(o.id)).toBe(1);
    expect(await getWardrobe(otro)).toBe(200);
    expect(await hashOf(u.id)).not.toBe(await hashOf(o.id));
  }, 30_000);

  it("una contraseña actual de más de 72 bytes (y ≤ 128 caracteres) es válida como actual", async () => {
    const LONG = `Aa1${"x".repeat(97)}`; // 100 bytes: el login ya la acepta
    const u = await createUser("larga@s.com", LONG);
    const a = (await login("larga@s.com", LONG))!;
    expect(a).toBeDefined();
    const r = await change(a, { currentPassword: LONG, newPassword: NEW });
    expect(r.status).toBe(200);
    expect(await bcrypt.compare(NEW, (await hashOf(u.id))!)).toBe(true);
    // 129 caracteres sí se rechazan como actual (tope del login)
    await createUser("larga2@s.com", PASS);
    const a2 = (await login("larga2@s.com", PASS))!;
    expect((await change(a2, { currentPassword: "y".repeat(129), newPassword: NEW })).status).toBe(422);
  }, 30_000);
});

describe("autenticación y sid", () => {
  it("sin sesión → 401 sin consumir contador ni ejecutar bcrypt", async () => {
    const r = await change(null, { currentPassword: PASS, newPassword: NEW });
    expect(r.status).toBe(401);
    expect(accountPasswordCalls()).toEqual([]);
    expect(await t.prisma.rateLimit.count({ where: { key: { startsWith: "account-password:" } } })).toBe(0);
    expect(compareSpy).not.toHaveBeenCalled(); expect(hashSpy).not.toHaveBeenCalled();
  });

  it("JWT revocado → 401", async () => {
    const u = await createUser("rev@s.com", PASS);
    const a = (await login("rev@s.com", PASS))!;
    await t.prisma.session.deleteMany({ where: { userId: u.id } });
    expect((await change(a, { currentPassword: PASS, newPassword: NEW })).status).toBe(401);
    expect(accountPasswordCalls()).toEqual([]);
  });

  it("sid no recuperable (la petición no lleva la cookie legible) → 401 sin cambios ni revocaciones; el intento sí cuenta", async () => {
    const u = await createUser("sid@s.com", PASS);
    const { a, b } = await session2("sid@s.com");
    const before = await hashOf(u.id);
    compareSpy.mockClear(); hashSpy.mockClear();
    const r = await change(a, { currentPassword: PASS, newPassword: NEW }, { cookieHeader: false });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("UNAUTHORIZED");
    expect(await hashOf(u.id)).toBe(before);
    expect(await sessions(u.id)).toBe(2);        // NO se revocó nada (ni «todas»)
    expect(await getWardrobe(b)).toBe(200);
    expect(await counter(u.id)).toBe(1);
    expect(compareSpy).not.toHaveBeenCalled(); expect(hashSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("JWT cuyo sub no es el usuario autenticado → 401 (no se usa un sid ajeno)", async () => {
    const u = await createUser("sub@s.com", PASS);
    const o = await createUser("sub2@s.com", PASS);
    const a = (await login("sub@s.com", PASS))!;
    const ob = (await login("sub2@s.com", PASS))!;
    // auth() ve la cookie de `a`; getToken (cabecera) lee la de otro usuario
    req.cookie = `${COOKIE}=${a}`;
    const res = await POST(new Request(`${BASE}/api/account/password`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "localhost:3000", cookie: `${COOKIE}=${ob}` }, body: JSON.stringify({ currentPassword: PASS, newPassword: NEW }) }));
    expect(res.status).toBe(401);
    expect(await sessions(u.id)).toBe(1); expect(await sessions(o.id)).toBe(1);
  }, 30_000);

  it("origen distinto → 403 BAD_ORIGIN antes de cualquier efecto", async () => {
    const u = await createUser("csrf@s.com", PASS);
    const a = (await login("csrf@s.com", PASS))!;
    const r = await change(a, { currentPassword: PASS, newPassword: NEW }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("BAD_ORIGIN");
    expect(await counter(u.id)).toBe(0);
  }, 30_000);
});

describe("rechazos (el hash y las sesiones no cambian y el intento consume contador)", () => {
  async function setup(email: string, password: string | null = PASS) {
    const u = await createUser(email, password);
    const { a, b } = await session2(email);
    compareSpy.mockClear(); hashSpy.mockClear();
    return { u, a, b, before: await hashOf(u.id) };
  }
  const untouched = async (s: Awaited<ReturnType<typeof setup>>, attempts: number) => {
    expect(await hashOf(s.u.id)).toBe(s.before);
    expect(await sessions(s.u.id)).toBe(2);
    expect(await getWardrobe(s.b)).toBe(200);
    expect(await counter(s.u.id)).toBe(attempts);
  };

  it("403 BAD_PASSWORD: contraseña actual incorrecta (sin hash nuevo)", async () => {
    const s = await setup("bad@s.com");
    const r = await change(s.a, { currentPassword: "Otra-clave-1", newPassword: NEW });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("BAD_PASSWORD");
    expect(hashSpy).not.toHaveBeenCalled();
    await untouched(s, 1);
  }, 30_000);

  it("409 NO_LOCAL_PASSWORD: cuenta sin passwordHash (sin bcrypt)", async () => {
    const u = await createUser("nohash@s.com", null);
    const sid = "sid-sin-contrasena-0123456789abcdefghijklmnopqrstuv";
    await t.prisma.session.create({ data: { userId: u.id, sessionToken: sha(sid), expires: new Date(Date.now() + 86_400_000) } });
    const jwt = await encode({ token: { sub: u.id, sid }, secret: SECRET, salt: COOKIE, maxAge: 14 * 86400 });
    const r = await change(jwt, { currentPassword: PASS, newPassword: NEW });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("NO_LOCAL_PASSWORD");
    expect(compareSpy).not.toHaveBeenCalled(); expect(hashSpy).not.toHaveBeenCalled();
    expect(await hashOf(u.id)).toBeNull();
    expect(await counter(u.id)).toBe(1);
  }, 30_000);

  it("422 SAME_PASSWORD: idéntica a la actual (una sola comparación bcrypt, sin hash nuevo)", async () => {
    const s = await setup("same@s.com");
    const r = await change(s.a, { currentPassword: PASS, newPassword: PASS });
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe("SAME_PASSWORD");
    expect(compareSpy).toHaveBeenCalledTimes(1);
    expect(hashSpy).not.toHaveBeenCalled();
    await untouched(s, 1);
  }, 30_000);

  it("422 por validación (composición, mínimo, 128 caracteres, 72 bytes UTF-8, campos ausentes): sin bcrypt y cada intento cuenta", async () => {
    const s = await setup("val@s.com");
    const bodies: unknown[] = [
      { currentPassword: PASS, newPassword: "sinmayuscula1" },
      { currentPassword: PASS, newPassword: "SINMINUSCULA1" },
      { currentPassword: PASS, newPassword: "SinNumeroAqui" },
      { currentPassword: PASS, newPassword: "Corta1a" },
      { currentPassword: PASS, newPassword: `Aa1${"x".repeat(126)}` },            // 129 caracteres
      { currentPassword: PASS, newPassword: `Aa1${"x".repeat(70)}` },             // 73 bytes
      { currentPassword: PASS, newPassword: `${"ñ".repeat(34)}Aa1xy` },           // 73 bytes con multibyte
      { currentPassword: PASS, newPassword: `${"😀".repeat(18)}Aa1` },            // 75 bytes
      { currentPassword: "", newPassword: NEW },
      { newPassword: NEW },
      { currentPassword: PASS },
    ];
    for (const [i, body] of bodies.entries()) {
      const r = await change(s.a, body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect(r.body.error?.code).toBe("VALIDATION");
      expect(await counter(s.u.id), `intento ${i + 1}`).toBe((i % 5) + 1);
      if (i % 5 === 4) await t.prisma.rateLimit.deleteMany({ where: { key: `account-password:${s.u.id}` } }); // vuelve a empezar antes del 6.º (429)
    }
    expect(compareSpy).not.toHaveBeenCalled(); expect(hashSpy).not.toHaveBeenCalled();
    expect(await hashOf(s.u.id)).toBe(s.before);
    expect(await sessions(s.u.id)).toBe(2);
  }, 30_000);

  it("la nueva contraseña de exactamente 72 bytes es válida (ñ y emoji en el límite)", async () => {
    const s = await setup("limite@s.com");
    expect((await change(s.a, { currentPassword: PASS, newPassword: `${"😀".repeat(17)}Aa1x` })).status).toBe(200); // 72 bytes
    expect(await sessions(s.u.id)).toBe(1);
  }, 30_000);
});

describe("límite por usuario (5 por hora, antes de validar)", () => {
  it("el sexto intento recibe 429 antes de validar el cuerpo y sin ejecutar bcrypt, aunque los datos sean correctos", async () => {
    const u = await createUser("lim@s.com", PASS);
    const { a, b } = await session2("lim@s.com");
    for (let i = 0; i < 5; i++) expect((await change(a, { currentPassword: "Otra-clave-1", newPassword: NEW })).status).toBe(403);
    expect(await counter(u.id)).toBe(5);
    compareSpy.mockClear(); hashSpy.mockClear();
    const before = await hashOf(u.id);

    const invalid = await change(a, { nope: true });                       // cuerpo inválido: 429, no 422
    expect(invalid.status).toBe(429);
    const valid = await change(a, { currentPassword: PASS, newPassword: NEW }); // correcto, pero ya limitado
    expect(valid.status).toBe(429);
    expect(compareSpy).not.toHaveBeenCalled(); expect(hashSpy).not.toHaveBeenCalled();
    expect(await hashOf(u.id)).toBe(before);
    expect(await sessions(u.id)).toBe(2);
    expect(await getWardrobe(b)).toBe(200);
  }, 60_000);

  it("fail-closed: si falla el almacenamiento del limitador, la operación se rechaza sin modificar nada", async () => {
    const u = await createUser("fail@s.com", PASS);
    const { a, b } = await session2("fail@s.com");
    const before = await hashOf(u.id);
    compareSpy.mockClear(); hashSpy.mockClear();
    lim.failAccountPassword = true;
    const r = await change(a, { currentPassword: PASS, newPassword: NEW });
    expect(r.status).toBe(500);
    expect(await hashOf(u.id)).toBe(before);
    expect(await sessions(u.id)).toBe(2);
    expect(await getWardrobe(b)).toBe(200);
    expect(compareSpy).not.toHaveBeenCalled(); expect(hashSpy).not.toHaveBeenCalled();
    expect(r.text).not.toContain("almacenamiento");
    expect(errSpy).toHaveBeenCalled();
  }, 30_000);
});

describe("concurrencia y atomicidad", () => {
  /** Ejecuta `rival` justo después de generar el hash nuevo y antes de la transacción: la ventana del compare-and-set. */
  const duringHash = (rival: () => Promise<void>) => {
    const orig = bcrypt.hash.bind(bcrypt) as unknown as (s: string, r: number) => Promise<string>;
    hashSpy.mockImplementationOnce((async (s: string, r: number) => { const h = await orig(s, r); await rival(); return h; }) as never);
  };

  it("409 CONFLICT si otro cambio de contraseña se confirma entre la lectura y el compare-and-set; gana el primero", async () => {
    const u = await createUser("race@s.com", PASS);
    const { a, b } = await session2("race@s.com");
    const rival = "Rival-clave-123";
    let rivalRes = 0;
    duringHash(async () => { rivalRes = (await change(b, { currentPassword: PASS, newPassword: rival })).status; });
    const r = await change(a, { currentPassword: PASS, newPassword: NEW });
    expect(rivalRes).toBe(200);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("CONFLICT");
    const h = (await hashOf(u.id))!;
    expect(await bcrypt.compare(rival, h)).toBe(true);
    expect(await bcrypt.compare(NEW, h)).toBe(false);
    // El rival (sesión b) conservó la suya y revocó la de a; el perdedor no tocó nada más.
    expect(await sessions(u.id)).toBe(1);
    expect(await getWardrobe(b)).toBe(200);
    expect(await getWardrobe(a)).toBe(401);
  }, 60_000);

  it("carrera con restablecimiento por email: el cambio recibe 409 y manda el hash del restablecimiento", async () => {
    const u = await createUser("reset@s.com", PASS);
    const { a } = await session2("reset@s.com");
    const { authService } = await import("@/services/auth.service");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await authService.requestReset("reset@s.com");
    const raw = /token=([a-f0-9]{64})/.exec(info.mock.calls.map((c) => String(c[0])).join("\n"))![1]!;
    info.mockRestore();
    const RESET = "Reset-clave-456";
    duringHash(async () => { await authService.resetPassword(raw, RESET); });
    const r = await change(a, { currentPassword: PASS, newPassword: NEW });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("CONFLICT");
    const h = (await hashOf(u.id))!;
    expect(await bcrypt.compare(RESET, h)).toBe(true);
    expect(await bcrypt.compare(NEW, h)).toBe(false);
    expect(await sessions(u.id)).toBe(0); // el restablecimiento revocó todas y el cambio no creó ninguna
    expect(await getWardrobe(a)).toBe(401);
  }, 60_000);

  it("atomicidad: si falla la revocación, el hash tampoco cambia (la actualización llegó a ejecutarse y se deshizo)", async () => {
    const u = await createUser("atom@s.com", PASS);
    const { a, b } = await session2("atom@s.com");
    const before = await hashOf(u.id);
    const { userRepository } = await import("@/repositories/user.repository");
    const { sessionRepository } = await import("@/repositories/session.repository");
    const cas = vi.spyOn(userRepository, "setPasswordIfUnchanged");
    vi.spyOn(sessionRepository, "deleteOthers").mockRejectedValueOnce(new Error("fallo simulado al revocar"));
    const r = await change(a, { currentPassword: PASS, newPassword: NEW });
    expect(r.status).toBe(500);
    expect(await cas.mock.results[0]!.value).toBe(1);   // el UPDATE sí se ejecutó dentro de la transacción…
    expect(await hashOf(u.id)).toBe(before);             // …y se revirtió
    expect(await sessions(u.id)).toBe(2);
    expect(await getWardrobe(a)).toBe(200); expect(await getWardrobe(b)).toBe(200);
    expect(await bcrypt.compare(PASS, (await hashOf(u.id))!)).toBe(true);
  }, 30_000);

  it("las respuestas no revelan hashes ni sid", async () => {
    const u = await createUser("leak@s.com", PASS);
    const a = (await login("leak@s.com", PASS))!;
    const hash = (await hashOf(u.id))!;
    const bad = await change(a, { currentPassword: "Otra-clave-1", newPassword: NEW });
    const ok = await change(a, { currentPassword: PASS, newPassword: NEW });
    for (const r of [bad, ok]) { expect(r.text).not.toContain(hash); expect(r.text).not.toContain(await sidOf(a)); }
    expect(ok.text).toBe(JSON.stringify({ ok: true }));
  }, 30_000);
});
