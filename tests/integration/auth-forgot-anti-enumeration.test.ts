import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";
import { MailDeadlineError } from "@/lib/mail/failure";

/**
 * Fase F.2 — recuperación de contraseña sin enumeración, con ruta, servicio, repositorio y base de datos reales (PGlite). Solo se
 * simulan `after` (la prueba decide cuándo ejecuta el trabajo diferido) y el envío de correo. Comprueba el estado persistente: qué
 * token queda guardado, con qué caducidad y que no sobrevive ninguno que nadie haya recibido.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; text: string }[], fail: null as null | (() => Error) }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string, _s: string, text: string) => { if (mail.fail) throw mail.fail(); mail.sent.push({ to, text }); } }));

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
let t: TestDb;
let POST: (req: Request) => Promise<Response>;
let ip = 0;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  POST = ((await import("@/app/api/auth/forgot-password/route")) as { POST: (req: Request) => Promise<Response> }).POST;
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

const send = (email: string) => POST(new Request("http://localhost:3000/api/auth/forgot-password", {
  method: "POST", body: JSON.stringify({ email }),
  headers: { "content-type": "application/json", "x-forwarded-host": "localhost:3000", "x-forwarded-for": `203.0.113.${(++ip % 250) + 1}` },
}));
const runJobs = async () => { for (const j of bg.jobs.splice(0)) await j(); };
const createUser = (email: string, passwordHash: string | null = "x") => t.prisma.user.create({ data: { email, emailVerified: new Date(), passwordHash, profile: { create: {} } } });
const tokens = () => t.prisma.verificationToken.findMany({ orderBy: { identifier: "asc" } });
const rawFromMail = (i = -1) => /token=([0-9a-f]{64})/.exec(mail.sent.at(i)!.text)![1]!;

describe("respuesta idéntica y estado persistente", () => {
  it("cuenta existente, inexistente y sin contraseña: la misma respuesta; solo la existente guarda token y envía correo (tras responder)", async () => {
    await createUser("existe@example.com");
    await createUser("oauth@example.com", null);
    const bodies: string[] = [];
    for (const email of ["existe@example.com", "no-existe@example.com", "oauth@example.com"]) {
      const res = await send(email);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(await tokens()).toEqual([]);               // nada se ha hecho todavía: todo va en `after()`
    expect(mail.sent).toEqual([]);
    await runJobs();
    const rows = await tokens();
    expect(rows.map((r) => r.identifier)).toEqual(["existe@example.com"]);
    expect(mail.sent.map((m) => m.to)).toEqual(["existe@example.com"]);
  });

  it("el token guardado conserva su caducidad (1 h), su tipo y su hash; el correo lleva el token en claro", async () => {
    await createUser("ana@example.com");
    const before = Date.now();
    await send("ana@example.com"); await runJobs();
    const [row] = await tokens();
    expect(row!.kind).toBe("RESET_PASSWORD");
    expect(row!.token).toBe(sha256(rawFromMail()));
    expect(row!.token).not.toBe(rawFromMail());
    const ttl = row!.expires.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(3_600_000 - 50);
    expect(ttl).toBeLessThanOrEqual(3_600_000 + 5_000);
  });
});

describe("fallo de envío SMTP", () => {
  it("la respuesta es la misma, no queda ningún token sin entregar y el fallo se registra sin datos sensibles", async () => {
    await createUser("ana@example.com");
    const ok = await (await send("no-existe@example.com")).text();
    mail.fail = () => Object.assign(new Error("Recipient address rejected: ana@example.com"), { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
    const res = await send("ana@example.com");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ok);
    await expect(runJobs()).resolves.toBeUndefined();
    expect(await tokens()).toEqual([]);               // el token recién creado se eliminó
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("Fallo de envío de correo (code=EENVELOPE, responseCode=550, command=RCPT TO)");
    expect(logged).not.toContain("ana@example.com");
    expect(logged).not.toContain("Recipient address rejected");
  });

  it("reintento: con el SMTP recuperado queda un único token válido y distinto del fallido", async () => {
    await createUser("ana@example.com");
    mail.fail = () => new Error("caído");
    await send("ana@example.com"); await runJobs();
    expect(await tokens()).toEqual([]);
    mail.fail = null;
    await send("ana@example.com"); await runJobs();
    const rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(sha256(rawFromMail()));
    expect(mail.sent).toHaveLength(1);
  });

  it("un segundo envío correcto sustituye al token anterior, como siempre (replace): nunca más de un token por cuenta y tipo", async () => {
    await createUser("ana@example.com");
    await send("ana@example.com"); await runJobs();
    const first = rawFromMail();
    await send("ana@example.com"); await runJobs();
    const rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(sha256(rawFromMail()));
    expect(rows[0]!.token).not.toBe(sha256(first));   // el enlace anterior ya no existe: la política de un único token activo no cambia
  });

  it("plazo total de envío (entrega incierta): el token se CONSERVA en la base de datos, con su caducidad, y el fallo se registra saneado", async () => {
    await createUser("ana@example.com");
    mail.fail = () => new MailDeadlineError();
    const before = Date.now();
    const res = await send("ana@example.com");
    expect(res.status).toBe(200);
    await expect(runJobs()).resolves.toBeUndefined();
    const rows = await tokens();
    expect(rows).toHaveLength(1);                     // no se borra: el correo puede llegar tarde y su enlace debe seguir siendo válido
    expect(rows[0]!.identifier).toBe("ana@example.com");
    expect(rows[0]!.kind).toBe("RESET_PASSWORD");
    const ttl = rows[0]!.expires.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(3_600_000 - 50);
    expect(ttl).toBeLessThanOrEqual(3_600_000 + 5_000);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("auth.reset.mail_uncertain");
    expect(logged).toContain("Entrega de correo incierta (plazo de envío agotado)");
    expect(logged).not.toContain("ana@example.com");
    expect(logged).not.toContain(rows[0]!.token);
  });

  it("tras una entrega incierta, el reintento sustituye al token conservado: queda uno solo", async () => {
    await createUser("ana@example.com");
    mail.fail = () => new MailDeadlineError();
    await send("ana@example.com"); await runJobs();
    const [kept] = await tokens();
    mail.fail = null;
    await send("ana@example.com"); await runJobs();
    const rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).not.toBe(kept!.token);
    expect(rows[0]!.token).toBe(sha256(rawFromMail()));
  });

  it("el fallo de la limpieza (la base de datos falla al borrar) se registra saneado y no altera la respuesta", async () => {
    await createUser("ana@example.com");
    mail.fail = () => new Error("caído");
    // `replace` borra por (identifier, kind); la limpieza borra por `token`: solo esta última falla.
    const original = t.prisma.verificationToken.deleteMany.bind(t.prisma.verificationToken);
    vi.spyOn(t.prisma.verificationToken, "deleteMany").mockImplementation(((args: { where?: { token?: string } }) => {
      if (args?.where?.token !== undefined) throw Object.assign(new Error("Invalid `deleteMany()` where token HASH ana@example.com"), { name: "PrismaClientKnownRequestError", code: "P1001" });
      return original(args as never);
    }) as never);
    const res = await send("ana@example.com");
    expect(res.status).toBe(200);
    await expect(runJobs()).resolves.toBeUndefined();
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("auth.reset.mail");
    expect(logged).toContain("auth.reset.token_cleanup");
    expect(logged).toContain("Fallo de base de datos (P1001)");
    expect(logged).not.toContain("HASH");
    expect(logged).not.toContain("ana@example.com");
  });
});
