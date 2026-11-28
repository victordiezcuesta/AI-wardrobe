import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { applyMigrations, listMigrations } from "../helpers/migrations";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Concurrencia REAL (varias conexiones independientes a PostgreSQL) de las operaciones de autenticación y de cuenta, con los
 * servicios de producción: registro, restablecimiento y cambio de contraseña, revocación de sesiones, límites de peticiones,
 * cuota diaria de IA y borrado de cuenta. Complementa pg-concurrency (tokens, medios, lease) y rate-limit-purge-pg (purga).
 *
 * Se omite salvo que exista TEST_PG_URL (PostgreSQL local y desechable; contraseña por PGPASSWORD). Cada ejecución crea su
 * base `authc_<aleatorio>` y la elimina al terminar. Correo y Cloudinary están simulados.
 */
const ADMIN_URL = process.env.TEST_PG_URL;
const isLocal = (u: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(u).hostname);
const TEMP_DB = /^authc_[a-z0-9]{1,8}$/;

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string) => { mail.sent.push(to); } }));
vi.mock("@/lib/cloudinary", () => ({ deleteAllUserAssets: async () => undefined }));

let dbName = "";
let app: PrismaClient; // pool de 8 conexiones: las operaciones de cada prueba corren de verdad en paralelo
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
const codes = (rs: PromiseSettledResult<unknown>[]) => rs.map((r) => (r.status === "fulfilled" ? "ok" : String((r.reason as { code?: unknown }).code ?? (r.reason as Error).message)));

const mkUser = async (password = "Clave-12345") =>
  app.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash(password, 4), emailVerified: new Date() } });
const mkSession = async (userId: string) => {
  const sid = randomUUID();
  await app.session.create({ data: { userId, sessionToken: sha(sid), expires: new Date(Date.now() + 3_600_000) } });
  return sid;
};

describe.skipIf(!ADMIN_URL)("PostgreSQL real: autenticación, cuenta y límites con operaciones simultáneas", () => {
  beforeAll(async () => {
    if (!isLocal(ADMIN_URL!)) throw new Error("TEST_PG_URL debe apuntar a un PostgreSQL local y desechable");
    setTestEnv();
    // bcrypt con coste 12 (el real) en cada prueba haría la suite lenta: el coste no afecta a lo que se comprueba aquí.
    const realHash = bcrypt.hash.bind(bcrypt) as (d: string, s: string | number) => Promise<string>;
    vi.spyOn(bcrypt, "hash").mockImplementation(((d: string, s: string | number) => realHash(d, typeof s === "number" ? Math.min(s, 4) : s)) as unknown as typeof bcrypt.hash);
    dbName = `authc_${Math.random().toString(36).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    const setup = new pg.Client({ connectionString: url.toString() });
    await setup.connect();
    try { await applyMigrations((sql) => setup.query(sql), listMigrations()); } finally { await setup.end(); }
    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 8 }) });
    holder.prisma = app;
  }, 60_000);

  afterAll(async () => {
    if (!ADMIN_URL || !dbName) return;
    if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base de datos temporal inesperado: no se borra nada");
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await admin.end(); }
    await app?.$disconnect();
  });

  it("rateLimit: 60 llamadas simultáneas con límite 25 → exactamente 25 pasan y 35 reciben 429; el contador es exacto", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const rs = await settle(Array.from({ length: 60 }, () => rateLimit("race-key", 25, 3600)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(25);
    expect(rs.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 429)).toHaveLength(35);
    expect((await app.rateLimit.findUniqueOrThrow({ where: { key: "race-key" } })).count).toBe(60);
  });

  it("cuota diaria de IA: reservas simultáneas de un usuario nunca superan el límite; otro usuario no se ve afectado", async () => {
    const { aiUsageService } = await import("@/services/ai-usage.service");
    const [a, b] = [await mkUser(), await mkUser()];
    const entry = { task: "TRY_ON" as const, provider: "p", model: "m" };
    const limit = 10; // TRYON_DAILY_LIMIT_PER_USER por defecto
    const rs = await settle([
      ...Array.from({ length: 30 }, () => aiUsageService.reserve(a.id, entry, "TRY_ON")),
      aiUsageService.reserve(b.id, entry, "TRY_ON"),
    ]);
    expect(rs.slice(0, 30).filter((r) => r.status === "fulfilled")).toHaveLength(limit);
    expect(rs[30]?.status).toBe("fulfilled");
    expect(await app.aiUsageLog.count({ where: { userId: a.id } })).toBe(limit);
  });

  it("registro: 6 solicitudes simultáneas del mismo email → una sola cuenta, sin errores y un único correo de verificación", async () => {
    const { authService } = await import("@/services/auth.service");
    const email = `${randomUUID()}@example.test`;
    mail.sent.length = 0;
    const rs = await settle(Array.from({ length: 6 }, () => authService.register({ email, password: "Clave-12345" })));
    expect(codes(rs)).toEqual(Array(6).fill("ok"));
    expect(await app.user.count({ where: { email } })).toBe(1);
    expect(mail.sent.filter((t) => t === email)).toHaveLength(1);
    expect(await app.verificationToken.count({ where: { identifier: email } })).toBe(1);
  });

  it("restablecer contraseña: 5 usos simultáneos del mismo token → uno gana, el resto INVALID_TOKEN; sesiones revocadas y contraseña de un único ganador", async () => {
    const { authService } = await import("@/services/auth.service");
    const user = await mkUser();
    await Promise.all([mkSession(user.id), mkSession(user.id)]);
    const raw = "r".repeat(40);
    await app.verificationToken.create({ data: { identifier: user.email, token: sha(raw), expires: new Date(Date.now() + 3_600_000), kind: "RESET_PASSWORD" } });
    const passwords = Array.from({ length: 5 }, (_, i) => `Nueva-clave-${i}`);
    const rs = await settle(passwords.map((p) => authService.resetPassword(raw, p)));
    expect(codes(rs).filter((c) => c === "ok")).toHaveLength(1);
    expect(codes(rs).filter((c) => c === "INVALID_TOKEN")).toHaveLength(4);
    const final = await app.user.findUniqueOrThrow({ where: { id: user.id } });
    const matching = (await Promise.all(passwords.map((p) => bcrypt.compare(p, final.passwordHash!)))).filter(Boolean);
    expect(matching).toHaveLength(1);
    expect(await app.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await app.verificationToken.count({ where: { identifier: user.email } })).toBe(0);
  });

  it("cambiar contraseña: dos cambios simultáneos con la misma contraseña actual → uno gana, el otro CONFLICT 409; solo sobrevive la sesión del ganador", async () => {
    const { accountService } = await import("@/services/account.service");
    const user = await mkUser("Actual-12345");
    const [s1, s2, s3] = [await mkSession(user.id), await mkSession(user.id), await mkSession(user.id)];
    const rs = await settle([
      accountService.changePassword(user.id, s1, "Actual-12345", "Nueva-AAAA-1"),
      accountService.changePassword(user.id, s2, "Actual-12345", "Nueva-BBBB-2"),
    ]);
    expect(codes(rs).sort()).toEqual(["CONFLICT", "ok"]);
    const winner = rs[0]?.status === "fulfilled" ? { sid: s1, pw: "Nueva-AAAA-1", other: "Nueva-BBBB-2" } : { sid: s2, pw: "Nueva-BBBB-2", other: "Nueva-AAAA-1" };
    const final = await app.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(winner.pw, final.passwordHash!)).toBe(true);
    expect(await bcrypt.compare(winner.other, final.passwordHash!)).toBe(false);
    const left = await app.session.findMany({ where: { userId: user.id } });
    expect(left.map((s) => s.sessionToken)).toEqual([sha(winner.sid)]); // la del perdedor y s3 se revocaron
    expect(s3).toBeTruthy();
  });

  it("cambiar contraseña frente a restablecerla a la vez: gane quien gane, queda la del restablecimiento y ninguna sesión", async () => {
    const { accountService } = await import("@/services/account.service");
    const { authService } = await import("@/services/auth.service");
    for (let round = 0; round < 4; round++) {
      const user = await mkUser("Actual-12345");
      const sid = await mkSession(user.id);
      await mkSession(user.id);
      const raw = `t${round}`.padEnd(40, "x");
      await app.verificationToken.create({ data: { identifier: user.email, token: sha(raw), expires: new Date(Date.now() + 3_600_000), kind: "RESET_PASSWORD" } });
      const rs = await settle([
        accountService.changePassword(user.id, sid, "Actual-12345", "Cambio-propio-1"),
        authService.resetPassword(raw, "Restablecida-9"),
      ]);
      const [changed, reset] = rs;
      expect(reset?.status).toBe("fulfilled");
      if (changed?.status === "rejected") expect(["CONFLICT", "BAD_PASSWORD"]).toContain((changed.reason as { code: string }).code);
      const final = await app.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(await bcrypt.compare("Restablecida-9", final.passwordHash!)).toBe(true);
      expect(await app.session.count({ where: { userId: user.id } })).toBe(0);
    }
  });

  it("eliminar la cuenta dos veces a la vez: la cuenta y todo lo suyo desaparecen y ninguna petición deja datos a medias", async () => {
    const { accountService } = await import("@/services/account.service");
    const user = await mkUser("Actual-12345");
    await mkSession(user.id);
    await app.rateLimit.create({ data: { key: `account-password:${user.id}` } });
    await app.verificationToken.create({ data: { identifier: user.email, token: sha(randomUUID()), expires: new Date(Date.now() + 3_600_000) } });
    const rs = await settle([accountService.delete(user.id, "Actual-12345"), accountService.delete(user.id, "Actual-12345")]);
    expect(codes(rs).filter((c) => c === "ok").length).toBeGreaterThanOrEqual(1);
    // Regresión: el segundo borrado terminaba con P2025 (fallo interno de Prisma, 500). Ahora es idempotente: las dos terminan bien
    // (o la que llega después de que la cuenta ya no exista recibe el NOT_FOUND controlado de la comprobación inicial).
    for (const c of codes(rs)) expect(["ok", "NOT_FOUND"]).toContain(c);
    expect(await app.user.count({ where: { id: user.id } })).toBe(0);
    expect(await app.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await app.rateLimit.count({ where: { key: { endsWith: `:${user.id}` } } })).toBe(0);
    expect(await app.verificationToken.count({ where: { identifier: user.email } })).toBe(0);
  });

  /**
   * Carrera determinista entre el consumo de un token y el borrado de la cuenta: una transacción ajena retiene la fila del usuario
   * (`FOR UPDATE`); la operación consume el token (autocommit) y queda esperando su escritura sobre la cuenta; entonces se borra la
   * cuenta y se suelta. Antes la escritura terminaba en P2025 (500); ahora es el mismo INVALID_TOKEN controlado que un enlace muerto.
   */
  const raceWithAccountDelete = async (kind: "VERIFY_EMAIL" | "RESET_PASSWORD", run: (raw: string) => Promise<unknown>) => {
    const user = await app.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("Clave-12345", 4) } });
    const raw = `${kind[0]}`.repeat(40);
    await app.verificationToken.create({ data: { identifier: user.email, token: sha(raw), expires: new Date(Date.now() + 3_600_000), kind } });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      locked(); await gate;
      await tx.user.deleteMany({ where: { id: user.id } });
    }, { timeout: 20_000 });
    await isLocked;
    const op = settle([run(raw)]);
    for (let i = 0; i < 200 && (await app.verificationToken.count({ where: { token: sha(raw) } })) > 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await app.verificationToken.count({ where: { token: sha(raw) } })).toBe(0); // el token ya se consumió; la escritura espera el bloqueo
    release(); await holder;
    const [result] = await op;
    expect(await app.user.count({ where: { id: user.id } })).toBe(0);
    return result;
  };

  it("verificar el correo mientras se borra la cuenta: INVALID_TOKEN controlado, nunca un fallo interno de Prisma", async () => {
    const { authService } = await import("@/services/auth.service");
    const r = await raceWithAccountDelete("VERIFY_EMAIL", (raw) => authService.verifyEmail(raw));
    expect(r?.status).toBe("rejected");
    expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_TOKEN", status: 400 });
  });

  it("restablecer la contraseña mientras se borra la cuenta: INVALID_TOKEN controlado y no queda ninguna fila", async () => {
    const { authService } = await import("@/services/auth.service");
    const r = await raceWithAccountDelete("RESET_PASSWORD", (raw) => authService.resetPassword(raw, "Nueva-clave-1"));
    expect(r?.status).toBe("rejected");
    expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_TOKEN", status: 400 });
  });

  it("eliminar la cuenta mientras se cambia la contraseña: sin interbloqueo y sin sesiones ni usuario residuales", async () => {
    const { accountService } = await import("@/services/account.service");
    for (let round = 0; round < 3; round++) {
      const user = await mkUser("Actual-12345");
      const sid = await mkSession(user.id);
      await mkSession(user.id);
      const rs = await settle([
        accountService.changePassword(user.id, sid, "Actual-12345", "Cambio-propio-1"),
        accountService.delete(user.id, "Actual-12345"),
      ]);
      for (const r of rs) if (r.status === "rejected") expect(["NOT_FOUND", "CONFLICT", "BAD_PASSWORD"]).toContain((r.reason as { code?: string }).code);
      expect(await app.user.count({ where: { id: user.id } })).toBe(0);
      expect(await app.session.count({ where: { userId: user.id } })).toBe(0);
    }
  });
});
