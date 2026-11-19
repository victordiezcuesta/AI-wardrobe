import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Revocación de sesiones de extremo a extremo: Auth.js real (@auth/core) con la configuración de la app, cookies y JWT
 * cifrados de verdad, Prisma real sobre PGlite y los Route Handlers reales. Solo se simula `next/headers`, que fuera
 * de Next no existe, para que `auth()` lea la cookie de la «petición» en curso.
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
const DAY = 86_400_000;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

let t: TestDb;
let Auth: typeof import("@auth/core").Auth;
let authOptions: typeof import("@/lib/auth").authOptions;
let encode: typeof import("@auth/core/jwt").encode;
let decode: typeof import("@auth/core/jwt").decode;

beforeAll(async () => {
  setTestEnv();
  Object.assign(process.env, { AUTH_URL: BASE, AUTH_TRUST_HOST: "true" });
  t = await startTestDb();
  holder.prisma = t.prisma;
  ({ Auth } = await import("@auth/core"));
  ({ authOptions } = await import("@/lib/auth"));
  ({ encode, decode } = await import("@auth/core/jwt"));
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(() => { req.cookie = ""; });

const config = () => ({ ...authOptions, secret: SECRET, basePath: "/api/auth", trustHost: true });
const setCookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);
const cookieValue = (cookies: string[], name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

/** Login real por el endpoint de Credentials de Auth.js. Devuelve el JWT de la cookie de sesión (o undefined). */
async function login(email: string, password: string): Promise<string | undefined> {
  const csrfRes = await Auth(new Request(`${BASE}/api/auth/csrf`), config());
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await Auth(new Request(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: setCookies(csrfRes).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/dashboard` }),
  }), config());
  return cookieValue(setCookies(res), COOKIE);
}

/** /api/auth/session real: devuelve el cuerpo (null si la sesión no es válida) y si se ordenó borrar la cookie. */
async function readSession(jwt: string) {
  const res = await Auth(new Request(`${BASE}/api/auth/session`, { headers: { cookie: `${COOKIE}=${jwt}` } }), config());
  const cleared = res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=;`) || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c));
  return { body: (await res.json()) as { user?: { id?: string } } | null, cleared };
}

/** Acceso a un recurso protegido: Route Handler real GET /api/wardrobe con la cookie dada. */
async function getWardrobe(jwt: string): Promise<number> {
  req.cookie = `${COOKIE}=${jwt}`;
  const { GET } = await import("@/app/api/wardrobe/route");
  return (await GET(new Request(`${BASE}/api/wardrobe`, { headers: { cookie: req.cookie } }))).status;
}

/** Paso 1 del logout de la app: POST /api/auth/logout (revoca solo la sesión de esta cookie). */
async function logout(jwt: string): Promise<number> {
  const { POST } = await import("@/app/api/auth/logout/route");
  return (await POST(new Request(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie: `${COOKIE}=${jwt}`, origin: BASE, host: "localhost:3000" } }))).status;
}

async function createUser(email: string, password: string) {
  return t.prisma.user.create({ data: { email, name: "Test", emailVerified: new Date(), passwordHash: await bcrypt.hash(password, 4), profile: { create: {} } } });
}
const sidOf = async (jwt: string) => (await decode({ token: jwt, secret: SECRET, salt: COOKIE }))?.sid as string | undefined;
const rowOf = async (jwt: string) => t.prisma.session.findUnique({ where: { sessionToken: sha((await sidOf(jwt))!) } });

describe("creación y uso de sesiones", () => {
  it("el login crea una fila Session y un JWT con sid (en la base de datos solo su hash)", async () => {
    const u = await createUser("login@s.com", "Clave-12345");
    const jwt = await login("login@s.com", "Clave-12345");
    expect(jwt).toBeTruthy();
    const sid = await sidOf(jwt!);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes en base64url
    const rows = await t.prisma.session.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionToken).toBe(sha(sid!));
    expect(rows[0]!.sessionToken).not.toBe(sid);
    // Caducidad de la fila: 14 días + 1 (nunca antes que el JWT).
    expect(rows[0]!.expires.getTime() - Date.now()).toBeGreaterThan(14 * DAY);
    expect(rows[0]!.expires.getTime() - Date.now()).toBeLessThanOrEqual(15 * DAY);
  });

  it("una sesión válida da acceso a recursos protegidos (sesión, requireUserId y Route Handler)", async () => {
    const u = await createUser("valida@s.com", "Clave-12345");
    const jwt = (await login("valida@s.com", "Clave-12345"))!;
    const s = await readSession(jwt);
    expect(s.body?.user?.id).toBe(u.id);
    expect(s.cleared).toBe(false);
    req.cookie = `${COOKIE}=${jwt}`;
    const { requireUserId } = await import("@/lib/auth/session");
    await expect(requireUserId()).resolves.toBe(u.id);
    expect(await getWardrobe(jwt)).toBe(200);
  });

  it("credenciales incorrectas no crean ninguna sesión", async () => {
    const u = await createUser("mal@s.com", "Clave-12345");
    expect(await login("mal@s.com", "Otra-12345")).toBeUndefined();
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe("logout", () => {
  it("tras el logout, el JWT copiado antes deja de funcionar en sesión, páginas y API", async () => {
    const u = await createUser("logout@s.com", "Clave-12345");
    const jwt = (await login("logout@s.com", "Clave-12345"))!;
    const copied = jwt; // p. ej. robado antes de cerrar sesión
    expect(await getWardrobe(copied)).toBe(200);

    expect(await logout(jwt)).toBe(200);
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(0);

    const s = await readSession(copied);
    expect(s.body).toBeNull();
    expect(s.cleared).toBe(true); // Auth.js ordena borrar la cookie inválida
    req.cookie = `${COOKIE}=${copied}`;
    const { requireUserId, currentSession } = await import("@/lib/auth/session");
    await expect(requireUserId()).rejects.toMatchObject({ status: 401 });
    expect(await currentSession()).toBeNull(); // lo que usan páginas y layouts
    expect(await getWardrobe(copied)).toBe(401);
  });

  it("el logout de un dispositivo no afecta a otra sesión del mismo usuario", async () => {
    const u = await createUser("dos@s.com", "Clave-12345");
    const movil = (await login("dos@s.com", "Clave-12345"))!;
    const portatil = (await login("dos@s.com", "Clave-12345"))!;
    expect(await sidOf(movil)).not.toBe(await sidOf(portatil));
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(2);

    expect(await logout(movil)).toBe(200);
    expect(await getWardrobe(movil)).toBe(401);
    expect(await getWardrobe(portatil)).toBe(200);
    expect((await readSession(portatil)).body?.user?.id).toBe(u.id);
  });

  it("llamar directamente a /api/auth/signout también revoca la fila (events.signOut)", async () => {
    await createUser("signout@s.com", "Clave-12345");
    const jwt = (await login("signout@s.com", "Clave-12345"))!;
    const csrfRes = await Auth(new Request(`${BASE}/api/auth/csrf`), config());
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    await Auth(new Request(`${BASE}/api/auth/signout`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: [...setCookies(csrfRes), `${COOKIE}=${jwt}`].join("; ") },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${BASE}/login` }),
    }), config());
    expect(await rowOf(jwt)).toBeNull();
    expect(await getWardrobe(jwt)).toBe(401);
  });

  it("si la revocación falla en la base de datos, el logout responde error (no se da por cerrado)", async () => {
    await createUser("falla@s.com", "Clave-12345");
    const jwt = (await login("falla@s.com", "Clave-12345"))!;
    const spy = vi.spyOn(t.prisma.session, "deleteMany").mockRejectedValueOnce(new Error("Neon caído"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await logout(jwt)).toBe(500);
    spy.mockRestore(); errSpy.mockRestore();
    expect(await rowOf(jwt)).not.toBeNull(); // la sesión sigue registrada; el cliente avisa y no borra la cookie
  });

  it("logout sin cookie es inocuo", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");
    expect((await POST(new Request(`${BASE}/api/auth/logout`, { method: "POST" }))).status).toBe(200);
  });
});

describe("restablecimiento de contraseña", () => {
  it("revoca todas las sesiones anteriores y un nuevo login funciona", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const u = await createUser("reset@s.com", "Clave-12345");
    const a = (await login("reset@s.com", "Clave-12345"))!;
    const b = (await login("reset@s.com", "Clave-12345"))!;
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(2);

    const { authService } = await import("@/services/auth.service");
    await authService.requestReset("reset@s.com");
    const raw = /token=([a-f0-9]{64})/.exec(infoSpy.mock.calls.map((c) => String(c[0])).join("\n"))![1]!;
    await authService.resetPassword(raw, "NuevaClave-123");
    infoSpy.mockRestore();

    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(0);
    expect(await getWardrobe(a)).toBe(401);
    expect(await getWardrobe(b)).toBe(401);
    expect(await login("reset@s.com", "Clave-12345")).toBeUndefined(); // la antigua ya no vale

    const fresh = (await login("reset@s.com", "NuevaClave-123"))!;
    expect(fresh).toBeTruthy();
    expect(await getWardrobe(fresh)).toBe(200);
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(1);
  }, 30_000);

  it("contraseña y revocación van en la misma transacción: si falla, no cambia nada", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const u = await createUser("atomico@s.com", "Clave-12345");
    const jwt = (await login("atomico@s.com", "Clave-12345"))!;
    const before = (await t.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash;
    const { authService } = await import("@/services/auth.service");
    await authService.requestReset("atomico@s.com");
    const raw = /token=([a-f0-9]{64})/.exec(infoSpy.mock.calls.map((c) => String(c[0])).join("\n"))![1]!;
    infoSpy.mockRestore();

    // Se rompe la tabla Session para que el DELETE de la transacción falle.
    await t.db.exec(`ALTER TABLE "Session" RENAME TO "Session_off"`);
    try {
      await expect(authService.resetPassword(raw, "NuevaClave-123")).rejects.toThrow();
    } finally {
      await t.db.exec(`ALTER TABLE "Session_off" RENAME TO "Session"`);
    }
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(before); // contraseña intacta
    expect(await getWardrobe(jwt)).toBe(200); // y la sesión sigue como estaba
  }, 30_000);
});

describe("JWT inválidos", () => {
  let user: { id: string };
  beforeAll(async () => { user = await createUser("jwt@s.com", "Clave-12345"); });
  const forge = (token: Record<string, unknown>, secret = SECRET) => encode({ token, secret, salt: COOKIE, maxAge: 14 * 86400 });

  it("JWT bien cifrado pero sin sid → rechazado (p. ej. emitido antes de este cambio)", async () => {
    const jwt = await forge({ sub: user.id, email: "jwt@s.com" });
    expect((await readSession(jwt)).body).toBeNull();
    expect(await getWardrobe(jwt)).toBe(401);
  });

  it("sid inexistente → rechazado", async () => {
    const jwt = await forge({ sub: user.id, sid: "no-existe-en-la-base-de-datos-0123456789abc" });
    expect((await readSession(jwt)).body).toBeNull();
    expect(await getWardrobe(jwt)).toBe(401);
  });

  it("sid de otro usuario → rechazado", async () => {
    const otro = await createUser("otro@s.com", "Clave-12345");
    const jwtOtro = (await login("otro@s.com", "Clave-12345"))!;
    const jwt = await forge({ sub: user.id, sid: await sidOf(jwtOtro) });
    expect((await readSession(jwt)).body).toBeNull();
    expect(await getWardrobe(jwt)).toBe(401);
    expect(otro.id).not.toBe(user.id);
  });

  it("sesión caducada en la base de datos → rechazada", async () => {
    const jwt = (await login("jwt@s.com", "Clave-12345"))!;
    await t.prisma.session.update({ where: { sessionToken: sha((await sidOf(jwt))!) }, data: { expires: new Date(Date.now() - 1000) } });
    expect((await readSession(jwt)).body).toBeNull();
    expect(await getWardrobe(jwt)).toBe(401);
  });

  it("JWT manipulado o cifrado con otra clave → rechazado", async () => {
    const jwt = (await login("jwt@s.com", "Clave-12345"))!;
    const i = Math.floor(jwt.length / 2);
    const tampered = jwt.slice(0, i) + (jwt[i] === "A" ? "B" : "A") + jwt.slice(i + 1);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await readSession(tampered)).body).toBeNull();
    expect(await getWardrobe(tampered)).toBe(401);
    const otherKey = await forge({ sub: user.id, sid: await sidOf(jwt) }, "y".repeat(32));
    expect((await readSession(otherKey)).body).toBeNull();
    expect(await getWardrobe(otherKey)).toBe(401);
    errSpy.mockRestore();
    expect(await getWardrobe(jwt)).toBe(200); // el original sigue sirviendo
  });
});

describe("renovación de la caducidad", () => {
  it("una sesión activa con menos de 14 días restantes se renueva a 15 días", async () => {
    await createUser("renueva@s.com", "Clave-12345");
    const jwt = (await login("renueva@s.com", "Clave-12345"))!;
    const old = new Date(Date.now() + 10 * DAY); // última renovación hace ~5 días
    await t.prisma.session.update({ where: { sessionToken: sha((await sidOf(jwt))!) }, data: { expires: old } });
    expect(await getWardrobe(jwt)).toBe(200);
    const row = await rowOf(jwt);
    expect(row!.expires.getTime() - Date.now()).toBeGreaterThan(14 * DAY); // nunca antes que el JWT renovado ahora
    expect(row!.expires.getTime() - Date.now()).toBeLessThanOrEqual(15 * DAY);
  });

  it("si falla solo la escritura de renovación, la sesión ya validada sigue funcionando (y se reintenta después)", async () => {
    await createUser("renuevafalla@s.com", "Clave-12345");
    const jwt = (await login("renuevafalla@s.com", "Clave-12345"))!;
    const old = new Date(Date.now() + 10 * DAY);
    await t.prisma.session.update({ where: { sessionToken: sha((await sidOf(jwt))!) }, data: { expires: old } });
    const spy = vi.spyOn(t.prisma.session, "updateMany").mockRejectedValueOnce(new Error("Neon caído al escribir"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await getWardrobe(jwt)).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("session.extend"))).toBe(true); // queda registrado
    spy.mockRestore(); errSpy.mockRestore();
    expect((await rowOf(jwt))!.expires.getTime()).toBe(old.getTime()); // no se renovó
    expect(await getWardrobe(jwt)).toBe(200); // siguiente petición: reintenta y renueva
    expect((await rowOf(jwt))!.expires.getTime() - Date.now()).toBeGreaterThan(14 * DAY);
  });

  it("si falla la LECTURA de validación, no se concede acceso", async () => {
    await createUser("leefalla@s.com", "Clave-12345");
    const jwt = (await login("leefalla@s.com", "Clave-12345"))!;
    const spy = vi.spyOn(t.prisma.session, "findUnique").mockRejectedValueOnce(new Error("Neon caído al leer"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await getWardrobe(jwt)).toBe(401);
    spy.mockRestore(); errSpy.mockRestore();
    expect(await getWardrobe(jwt)).toBe(200); // recuperada la base de datos, la sesión (que no fue revocada) sigue valiendo
  });

  it("una sesión revocada no se renueva ni revive", async () => {
    await createUser("norevive@s.com", "Clave-12345");
    const jwt = (await login("norevive@s.com", "Clave-12345"))!;
    await t.prisma.session.update({ where: { sessionToken: sha((await sidOf(jwt))!) }, data: { expires: new Date(Date.now() + 10 * DAY) } });
    expect(await logout(jwt)).toBe(200);
    expect(await getWardrobe(jwt)).toBe(401);
    expect(await rowOf(jwt)).toBeNull();
  });

  it("una sesión reciente no provoca escrituras", async () => {
    await createUser("reciente@s.com", "Clave-12345");
    const jwt = (await login("reciente@s.com", "Clave-12345"))!;
    const before = (await rowOf(jwt))!.expires.getTime();
    const spy = vi.spyOn(t.prisma.session, "updateMany");
    for (let i = 0; i < 3; i++) expect(await getWardrobe(jwt)).toBe(200);
    expect((await readSession(jwt)).body).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await rowOf(jwt))!.expires.getTime()).toBe(before);
  });

  it("regla de renovación (reloj controlado): escribe como mucho una vez al día y la fila nunca caduca antes que el JWT", async () => {
    const { sessionService, SESSION_MAX_AGE_MS } = await import("@/services/session.service");
    const u = await createUser("reloj@s.com", "Clave-12345");
    const t0 = new Date();
    const sid = await sessionService.start(u.id, t0);
    const expiresAt = async () => (await t.prisma.session.findUniqueOrThrow({ where: { sessionToken: sha(sid) } })).expires.getTime();
    // Validaciones cada 6 h durante 3 días: en cada instante la fila sobrevive al JWT renovado (t + 14 días).
    let writes = 0; let prev = await expiresAt();
    for (let h = 6; h <= 72; h += 6) {
      const now = new Date(t0.getTime() + h * 3600_000);
      expect(await sessionService.validate({ sub: u.id, sid }, now)).toBe(true);
      const exp = await expiresAt();
      if (exp !== prev) writes++;
      prev = exp;
      expect(exp).toBeGreaterThanOrEqual(now.getTime() + SESSION_MAX_AGE_MS);
    }
    expect(writes).toBeLessThanOrEqual(3); // ~1 al día
    // Inactiva 16 días tras la última validación: caducada.
    expect(await sessionService.validate({ sub: u.id, sid }, new Date(t0.getTime() + 72 * 3600_000 + 16 * DAY))).toBe(false);
  });
});

describe("integridad", () => {
  it("borrar el usuario elimina sus sesiones (cascada) y su JWT deja de valer", async () => {
    const u = await createUser("borrar@s.com", "Clave-12345");
    const jwt = (await login("borrar@s.com", "Clave-12345"))!;
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(1);
    await t.prisma.user.delete({ where: { id: u.id } });
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(0);
    expect(await getWardrobe(jwt)).toBe(401);
  });

  it("el login limpia las sesiones caducadas del usuario", async () => {
    const u = await createUser("limpia@s.com", "Clave-12345");
    await t.prisma.session.create({ data: { userId: u.id, sessionToken: sha("vieja"), expires: new Date(Date.now() - DAY) } });
    await login("limpia@s.com", "Clave-12345");
    const rows = await t.prisma.session.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionToken).not.toBe(sha("vieja"));
  });
});
