import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";
import { MailDeadlineError } from "@/lib/mail/failure";

/**
 * Fase F.3 — registro sin enumeración, con ruta, servicio, repositorios, bcrypt real y base de datos real (PGlite). Solo se simulan `after`
 * (la prueba decide cuándo ejecuta el trabajo diferido) y el envío de correo. Comprueba el estado persistente: qué usuarios y tokens quedan,
 * que ninguna cuenta existente se modifica, la carrera de creación (el P2002 REAL del adaptador pg) y la verificación posterior.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], fail: null as null | (() => Error) }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string, subject: string, text: string) => { if (mail.fail) throw mail.fail(); mail.sent.push({ to, subject, text }); } }));

const PASS = "Abcdefghi1-secreta";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
let t: TestDb;
let POST: (req: Request) => Promise<Response>;
let authService: typeof import("@/services/auth.service").authService;
let ip = 0;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  POST = ((await import("@/app/api/auth/register/route")) as { POST: (req: Request) => Promise<Response> }).POST;
  ({ authService } = await import("@/services/auth.service"));
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  vi.stubEnv("VERCEL", "1");
  bg.jobs.length = 0; mail.sent.length = 0; mail.fail = null;
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "VerificationToken", "RateLimit" CASCADE`);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const send = (email: string, password = PASS, name?: string) => POST(new Request("http://localhost:3000/api/auth/register", {
  method: "POST", body: JSON.stringify({ email, password, ...(name ? { name } : {}) }),
  headers: { "content-type": "application/json", "x-forwarded-host": "localhost:3000", "x-forwarded-for": `203.0.113.${(++ip % 250) + 1}` },
}));
const runJobs = async () => { for (const j of bg.jobs.splice(0)) await j(); };
const runJobsConcurrently = () => Promise.all(bg.jobs.splice(0).map((j) => j()));
const users = () => t.prisma.user.findMany({ orderBy: { email: "asc" }, include: { profile: true } });
const tokens = () => t.prisma.verificationToken.findMany({ orderBy: { identifier: "asc" } });
const createUser = (email: string, verified: boolean, name = "Previo") => t.prisma.user.create({ data: { email, name, passwordHash: "hash-previo", emailVerified: verified ? new Date() : null, profile: { create: {} } } });
const rawFromMail = (i = -1) => /token=([0-9a-f]{64})/.exec(mail.sent.at(i)!.text)![1]!;
const logged = () => vi.mocked(console.error).mock.calls.flat().map(String).join("\n");

describe("respuesta idéntica y estado persistente", () => {
  it("cuenta nueva, verificada y sin verificar: la misma respuesta 201; nada se hace antes de responder", async () => {
    await createUser("verificada@example.com", true);
    await createUser("pendiente@example.com", false);
    const before = JSON.stringify(await users());
    const bodies: string[] = []; const statuses: number[] = [];
    for (const email of ["nueva@example.com", "verificada@example.com", "pendiente@example.com"]) {
      const res = await send(email);
      statuses.push(res.status); bodies.push(await res.text());
    }
    expect(statuses).toEqual([201, 201, 201]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." });
    expect(JSON.stringify(await users())).toBe(before);   // ni usuario nuevo ni cambios: todo va en `after()`
    expect(await tokens()).toEqual([]);
    expect(mail.sent).toEqual([]);
    expect(bg.jobs).toHaveLength(3);                       // un único trabajo por solicitud válida
  });

  it("tras el trabajo diferido: la cuenta nueva se crea con su perfil y un hash bcrypt (nunca la contraseña); se envía verificación a la nueva y a la sin verificar, no a la verificada", async () => {
    await createUser("verificada@example.com", true);
    await createUser("pendiente@example.com", false);
    for (const email of ["nueva@example.com", "verificada@example.com", "pendiente@example.com"]) await send(email, PASS, "Nombre nuevo");
    await runJobs();
    const all = await users();
    expect(all.map((u) => u.email)).toEqual(["nueva@example.com", "pendiente@example.com", "verificada@example.com"]);
    const nueva = all.find((u) => u.email === "nueva@example.com")!;
    expect(nueva.name).toBe("Nombre nuevo");
    expect(nueva.emailVerified).toBeNull();
    expect(nueva.profile).not.toBeNull();
    expect(nueva.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(nueva.passwordHash).not.toContain(PASS);
    expect(await bcrypt.compare(PASS, nueva.passwordHash!)).toBe(true);
    expect((await tokens()).map((r) => r.identifier)).toEqual(["nueva@example.com", "pendiente@example.com"]);
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["nueva@example.com", "pendiente@example.com"]);
  }, 30_000);

  it("las cuentas existentes NUNCA se modifican (ni contraseña, ni nombre, ni verificación), aunque se registren con otros datos", async () => {
    const v = await createUser("verificada@example.com", true);
    const p = await createUser("pendiente@example.com", false);
    await send("verificada@example.com", "Otra-contraseña-9Z", "Otro nombre");
    await send("pendiente@example.com", "Otra-contraseña-9Z", "Otro nombre");
    await runJobs();
    for (const before of [v, p]) {
      const after = await t.prisma.user.findUnique({ where: { id: before.id } });
      expect(after).toEqual(before);
    }
  });

  it("el token de verificación conserva su caducidad (24 h), su tipo y su hash; el correo conserva su contenido", async () => {
    const t0 = Date.now();
    await send("nueva@example.com"); await runJobs();
    const [row] = await tokens();
    expect(row!.kind).toBe("VERIFY_EMAIL");
    expect(row!.identifier).toBe("nueva@example.com");
    expect(row!.token).toBe(sha256(rawFromMail()));
    expect(row!.token).not.toBe(rawFromMail());
    const ttl = row!.expires.getTime() - t0;
    expect(ttl).toBeGreaterThanOrEqual(24 * 3_600_000 - 50);
    expect(ttl).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);
    expect(mail.sent[0]!.subject).toBe("Confirma tu email en AI Wardrobe");
    expect(mail.sent[0]!.text).toBe(`Confirma tu cuenta: http://localhost:3000/verify-email?token=${rawFromMail()} \nEl enlace caduca en 24 horas.`);
  }, 30_000);
});

describe("fallo de envío SMTP", () => {
  it("confirmado: misma respuesta, la cuenta queda creada sin token huérfano y el fallo se registra sin datos sensibles", async () => {
    const ok = await (await send("otra@example.com")).text();
    bg.jobs.length = 0;
    mail.fail = () => Object.assign(new Error("Recipient address rejected: nueva@example.com"), { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
    const res = await send("nueva@example.com");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe(ok);
    await expect(runJobs()).resolves.toBeUndefined();
    expect((await users()).map((u) => u.email)).toEqual(["nueva@example.com"]);
    expect(await tokens()).toEqual([]);                 // el token recién creado se eliminó
    expect(logged()).toContain("Fallo de envío de correo (code=EENVELOPE, responseCode=550, command=RCPT TO)");
    for (const secret of ["nueva@example.com", "Recipient address rejected", PASS]) expect(logged()).not.toContain(secret);
  }, 30_000);

  it("reintento tras un fallo: la cuenta sin verificar recibe un token nuevo y un único correo", async () => {
    mail.fail = () => new Error("caído");
    await send("nueva@example.com"); await runJobs();
    expect(await tokens()).toEqual([]);
    mail.fail = null;
    await send("nueva@example.com", "Otra-contraseña-9Z"); await runJobs();
    expect(await tokens()).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect((await users())).toHaveLength(1);
    expect(await bcrypt.compare(PASS, (await users())[0]!.passwordHash!)).toBe(true);   // la contraseña original no se sobrescribe
  }, 30_000);

  it("plazo total de envío (entrega incierta): el token se CONSERVA con su caducidad y se registra sin datos", async () => {
    mail.fail = () => new MailDeadlineError();
    await send("nueva@example.com");
    await expect(runJobs()).resolves.toBeUndefined();
    const rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("VERIFY_EMAIL");
    expect(rows[0]!.expires.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(logged()).toContain("auth.verify.mail_uncertain");
    expect(logged()).not.toContain("nueva@example.com");
    expect(logged()).not.toContain(rows[0]!.token);
  }, 30_000);
});

describe("carrera de creación", () => {
  it("dos registros simultáneos del mismo email nuevo: ninguno falla, queda UNA cuenta, UN token y UN correo (el de la solicitud que ganó)", async () => {
    const [a, b] = await Promise.all([send("carrera@example.com"), send("carrera@example.com", "Otra-contraseña-9Z")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await a.text()).toBe(await b.text());
    expect(bg.jobs).toHaveLength(2);
    await expect(runJobsConcurrently()).resolves.toHaveLength(2);   // el P2002 REAL del adaptador pg se trata como cuenta existente
    expect((await users()).map((u) => u.email)).toEqual(["carrera@example.com"]);
    expect(await tokens()).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect((await tokens())[0]!.token).toBe(sha256(rawFromMail()));   // el token guardado es el del correo enviado (no se sustituyó)
    expect(logged()).toBe("");                                          // sin errores registrados: no era un fallo
  }, 30_000);

  it("el P2002 de OTRA restricción (clave primaria de User) no se oculta: queda registrado y no se envía correo ni se guarda token", async () => {
    // Choque REAL: un usuario previo con id "fijo"; el `create` del registro se fuerza a usar ese mismo id → P2002 de User_pkey, no del email.
    await t.prisma.user.create({ data: { id: "fijo", email: "base@example.com", passwordHash: "x", profile: { create: {} } } });
    const create = t.prisma.user.create.bind(t.prisma.user);
    vi.spyOn(t.prisma.user, "create").mockImplementation(((args: { data: Record<string, unknown> }) => create({ ...args, data: { ...args.data, id: "fijo" } } as never)) as never);
    const res = await send("choca@example.com");
    expect(res.status).toBe(201);                       // la respuesta pública no cambia
    await expect(runJobs()).resolves.toBeUndefined();
    expect((await users()).map((u) => u.email)).toEqual(["base@example.com"]);
    expect(mail.sent).toEqual([]);
    expect(await tokens()).toEqual([]);
    expect(logged()).toContain("auth.register.deferred"); // no se trató como «cuenta existente»
    expect(logged()).toContain("Fallo de base de datos (P2002)");
    expect(logged()).not.toContain("choca@example.com");
    expect(logged()).not.toContain("fijo");
  }, 30_000);
});

describe("regresión del flujo de verificación", () => {
  it("con el token del correo se verifica la cuenta, el token se consume y no se puede reutilizar", async () => {
    await send("nueva@example.com"); await runJobs();
    const raw = rawFromMail();
    expect((await users())[0]!.emailVerified).toBeNull();
    await authService.verifyEmail(raw);
    expect((await users())[0]!.emailVerified).toBeInstanceOf(Date);
    expect(await tokens()).toEqual([]);
    await expect(authService.verifyEmail(raw)).rejects.toMatchObject({ code: "INVALID_TOKEN", status: 400 });
  }, 30_000);

  it("un token caducado se rechaza como siempre", async () => {
    await send("nueva@example.com"); await runJobs();
    await t.prisma.verificationToken.updateMany({ data: { expires: new Date(Date.now() - 1000) } });
    await expect(authService.verifyEmail(rawFromMail())).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  }, 30_000);
});
