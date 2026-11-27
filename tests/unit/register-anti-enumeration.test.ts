import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailDeadlineError } from "@/lib/mail/failure";

/**
 * Fase F.3 — registro sin enumeración de cuentas. Ruta REAL (`handler`, Zod, orden de límites) + `authService` REAL; simulados: `after`
 * (se captura el callback y lo ejecuta la prueba cuando quiere), los límites, bcrypt, los repositorios y el envío de correo. Sin base de
 * datos, sin SMTP, sin red. La respuesta pública no puede depender de si la cuenta existe, está verificada, es nueva ni de si el correo sale.
 */
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[], order: [] as string[] }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.order.push("after"); bg.jobs.push(fn); } }));
vi.mock("@/lib/rate-limit/ip", () => ({ rateLimitByIp: vi.fn(async () => { bg.order.push("ip"); }) }));
vi.mock("@/lib/rate-limit/email", () => ({ rateLimitByEmail: vi.fn(async () => { bg.order.push("email"); }) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const bcrypt = vi.hoisted(() => ({ hash: vi.fn(async () => "hash-simulado"), compare: vi.fn(async () => false) }));
vi.mock("bcryptjs", () => ({ default: bcrypt }));
const userRepo = vi.hoisted(() => ({ findByEmail: vi.fn(), create: vi.fn() }));
const tokenRepo = vi.hoisted(() => ({ replace: vi.fn(), find: vi.fn(), delete: vi.fn() }));
const mail = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("@/repositories/user.repository", () => ({ userRepository: userRepo }));
vi.mock("@/repositories/session.repository", () => ({ sessionRepository: {} }));
vi.mock("@/repositories/token.repository", () => ({ tokenRepository: tokenRepo }));
vi.mock("@/lib/mail", () => ({ sendMail: mail.sendMail }));

const EMAIL = "ana@example.com";
const PASS = "Abcdefghi1-secreta";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const post = (body: unknown = { email: EMAIL, password: PASS, name: "Ana" }) => new Request("http://localhost:3000/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const snapshot = async (res: Response) => ({ status: res.status, body: await res.text(), headers: [...res.headers].sort() });
const runJobs = async () => { for (const j of bg.jobs.splice(0)) await j(); };
const logs = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => String(c[0]));
const entries = (spy: { mock: { calls: unknown[][] } }) => logs(spy).map((l) => JSON.parse(l) as { scope: string; message: string });
const rawTokenFromMail = () => /token=([0-9a-f]{64})/.exec(String((mail.sendMail.mock.calls[0] as unknown[])[2]))![1]!;
const prismaError = (code: string, message: string, cause?: Record<string, unknown>) =>
  Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code, meta: cause ? { driverAdapterError: { name: "DriverAdapterError", cause } } : {} });
const uniqueOn = (constraint: Record<string, unknown>, table: string) => prismaError("P2002", `Unique constraint failed ${EMAIL}`, { kind: "UniqueConstraintViolation", constraint, table });
const pgEmailUnique = () => uniqueOn({ index: "User_email_key" }, "User");
const neonEmailUnique = () => uniqueOn({ fields: ["email"] }, "User");

let POST: (req: Request) => Promise<Response>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  bg.jobs.length = 0; bg.order.length = 0;
  userRepo.findByEmail.mockReset().mockResolvedValue(null); userRepo.create.mockReset().mockResolvedValue(undefined);
  tokenRepo.replace.mockReset().mockResolvedValue(undefined); tokenRepo.delete.mockReset().mockResolvedValue(undefined);
  bcrypt.hash.mockReset().mockResolvedValue("hash-simulado"); bcrypt.compare.mockReset().mockResolvedValue(false); // mockReset: descarta también respuestas encoladas por pruebas anteriores
  mail.sendMail.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test"); vi.stubEnv("DATABASE_URL", "postgres://x"); vi.stubEnv("AUTH_SECRET", "x".repeat(32));
  vi.stubEnv("CLOUDINARY_CLOUD_NAME", "d"); vi.stubEnv("CLOUDINARY_API_KEY", "k"); vi.stubEnv("CLOUDINARY_API_SECRET", "s");
  vi.stubEnv("OPENROUTER_API_KEY", "o"); vi.stubEnv("POLLINATIONS_API_KEY", "p");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  POST = ((await import("@/app/api/auth/register/route")) as { POST: (req: Request) => Promise<Response> }).POST;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const newAccount = () => userRepo.findByEmail.mockResolvedValue(null);
const verified = () => userRepo.findByEmail.mockResolvedValue({ email: EMAIL, emailVerified: new Date(), passwordHash: "h-previo" });
const unverified = () => userRepo.findByEmail.mockResolvedValue({ email: EMAIL, emailVerified: null, passwordHash: "h-previo" });

describe("respuesta pública equivalente", () => {
  it("cuenta nueva, verificada, sin verificar y fallo SMTP (confirmado o por plazo): mismo estado 201, cuerpo y cabeceras", async () => {
    const results: Awaited<ReturnType<typeof snapshot>>[] = [];
    const scenario = async (setup: () => void) => { setup(); results.push(await snapshot(await POST(post()))); await runJobs(); };
    await scenario(newAccount);
    await scenario(verified);
    await scenario(unverified);
    await scenario(() => { newAccount(); mail.sendMail.mockRejectedValue(Object.assign(new Error(`rechazado ${EMAIL}`), { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" })); });
    await scenario(() => { unverified(); mail.sendMail.mockRejectedValue(new Error("caído")); tokenRepo.delete.mockRejectedValue(new Error("también falla la limpieza")); });
    await scenario(() => { newAccount(); mail.sendMail.mockRejectedValue(new MailDeadlineError()); });
    await scenario(() => { newAccount(); userRepo.create.mockRejectedValue(pgEmailUnique()); });                       // carrera de creación
    await scenario(() => { userRepo.findByEmail.mockRejectedValue(prismaError("P1001", `no se alcanza la BD ${EMAIL}`)); }); // error de base de datos
    expect(results).toHaveLength(8);
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.status).toBe(201);
    expect(JSON.parse(results[0]!.body)).toEqual({ ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." });
  });
});

describe("el camino síncrono no depende de la cuenta (estructural)", () => {
  it("antes de responder no se consulta el usuario, no se ejecuta bcrypt, no se crea nada, no se emite token y no se envía correo", async () => {
    newAccount();
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(userRepo.create).not.toHaveBeenCalled();
    expect(tokenRepo.replace).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(bg.jobs).toHaveLength(1);                    // exactamente un trabajo diferido, sin promesas sueltas
    await runJobs();
    expect(userRepo.findByEmail).toHaveBeenCalledTimes(1);
    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
  });

  it("la respuesta no espera a la consulta, a bcrypt, a la creación ni al envío, aunque no terminen nunca", async () => {
    userRepo.findByEmail.mockReturnValue(new Promise(() => undefined));
    const a = await snapshot(await POST(post()));
    newAccount(); bcrypt.hash.mockReturnValueOnce(new Promise(() => undefined) as never);
    const b = await snapshot(await POST(post()));
    newAccount(); userRepo.create.mockReturnValue(new Promise(() => undefined));
    const c = await snapshot(await POST(post()));
    unverified(); mail.sendMail.mockReturnValue(new Promise(() => undefined));
    const d = await snapshot(await POST(post()));
    for (const r of [b, c, d]) expect(r).toEqual(a);
    expect(a.status).toBe(201);
  });

  it("el orden es: límite por IP → validación → límite por email → trabajo diferido → respuesta", async () => {
    await POST(post());
    expect(bg.order).toEqual(["ip", "email", "after"]);
  });

  it("si un límite rechaza (429) o la validación falla (422), no se programa nada ni se toca el usuario", async () => {
    const { rateLimitByEmail } = await import("@/lib/rate-limit/email");
    const { tooMany } = await import("@/lib/errors");
    vi.mocked(rateLimitByEmail).mockRejectedValueOnce(tooMany(30));
    expect((await POST(post())).status).toBe(429);
    expect((await POST(post({ email: "no-es-un-email", password: "x" }))).status).toBe(422);
    expect(bg.jobs).toHaveLength(0);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});

describe("lo que hace el trabajo diferido en cada caso", () => {
  it("cuenta nueva: bcrypt de coste 12, crea el usuario con el hash (nunca la contraseña), emite el token de 24 h y envía el correo de verificación", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
    newAccount();
    await POST(post()); await runJobs();
    expect(bcrypt.hash).toHaveBeenCalledWith(PASS, 12);
    expect(userRepo.create).toHaveBeenCalledWith({ email: EMAIL, name: "Ana", passwordHash: "hash-simulado" });
    const [identifier, kind, hash, expires] = tokenRepo.replace.mock.calls[0] as [string, string, string, Date];
    expect([identifier, kind]).toEqual([EMAIL, "VERIFY_EMAIL"]);
    expect(expires.toISOString()).toBe("2026-06-02T10:00:00.000Z");   // 24 horas
    const [to, subject, text] = mail.sendMail.mock.calls[0] as [string, string, string];
    const raw = rawTokenFromMail();
    expect(hash).toBe(sha256(raw));
    expect(to).toBe(EMAIL);
    expect(subject).toBe("Confirma tu email en AI Wardrobe");
    expect(text).toBe(`Confirma tu cuenta: https://app.test/verify-email?token=${raw} \nEl enlace caduca en 24 horas.`);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("cuenta verificada: no se hace nada (ni bcrypt, ni creación, ni token, ni correo) y la cuenta no se modifica", async () => {
    verified();
    await POST(post()); await runJobs();
    expect(userRepo.findByEmail).toHaveBeenCalledWith(EMAIL);
    for (const spy of [bcrypt.hash, userRepo.create, tokenRepo.replace, tokenRepo.delete, mail.sendMail]) expect(spy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("cuenta sin verificar: reenvía la verificación (token + correo) sin bcrypt y sin crear ni modificar el usuario", async () => {
    unverified();
    await POST(post()); await runJobs();
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(userRepo.create).not.toHaveBeenCalled();
    expect(tokenRepo.replace).toHaveBeenCalledTimes(1);
    expect((mail.sendMail.mock.calls[0] as unknown[])[1]).toBe("Confirma tu email en AI Wardrobe");
  });
});

describe("fallo de envío SMTP en el trabajo diferido", () => {
  const SECRET_ERROR = () => Object.assign(new Error(`Recipient address rejected: ${EMAIL} url=https://app.test/verify-email?token=XYZ pass=${PASS}`), {
    code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: `550 ${EMAIL}`, rejected: [EMAIL],
  });

  it("confirmado: no lanza, se registra saneado, se borra exactamente el token recién creado y no se filtra ningún dato", async () => {
    newAccount();
    mail.sendMail.mockRejectedValue(SECRET_ERROR());
    await POST(post());
    await expect(runJobs()).resolves.toBeUndefined();
    const raw = rawTokenFromMail();
    const storedHash = tokenRepo.replace.mock.calls[0]![2] as string;
    expect(storedHash).toBe(sha256(raw));
    expect(tokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(tokenRepo.delete).toHaveBeenCalledWith(storedHash);
    expect(tokenRepo.delete).not.toHaveBeenCalledWith(raw);
    expect(entries(errSpy).map((e) => e.scope)).toEqual(["auth.verify.mail"]);
    expect(entries(errSpy)[0]!.message).toBe("Fallo de envío de correo (code=EENVELOPE, responseCode=550, command=RCPT TO)");
    const out = logs(errSpy).join("\n");
    for (const secret of [EMAIL, PASS, raw, sha256(raw), "token=", "verify-email", "Recipient address rejected", "app.test", "hash-simulado"]) expect(out).not.toContain(secret);
  });

  it("un timeout PROPIO de nodemailer (ETIMEDOUT de conexión) es un fallo confirmado: se borra el token", async () => {
    newAccount();
    mail.sendMail.mockRejectedValue(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" }));
    await POST(post()); await runJobs();
    expect(tokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(entries(errSpy).map((e) => e.scope)).toEqual(["auth.verify.mail"]);
  });

  it("plazo total agotado (entrega incierta): el token NO se borra y se registra como incierta, sin datos", async () => {
    newAccount();
    mail.sendMail.mockRejectedValue(Object.assign(new MailDeadlineError(), { to: EMAIL, url: "https://app.test/verify-email?token=XYZ" }));
    await POST(post());
    await expect(runJobs()).resolves.toBeUndefined();
    expect(tokenRepo.replace).toHaveBeenCalledTimes(1);
    expect(tokenRepo.delete).not.toHaveBeenCalled();
    expect(entries(errSpy)).toHaveLength(1);
    expect(entries(errSpy)[0]).toMatchObject({ scope: "auth.verify.mail_uncertain", message: "Entrega de correo incierta (plazo de envío agotado)" });
    const out = logs(errSpy).join("\n");
    for (const secret of [EMAIL, PASS, sha256(rawTokenFromMail()), "token=", "Tiempo de envío agotado"]) expect(out).not.toContain(secret);
  });

  it("si también falla la limpieza, se registran AMBOS fallos saneados y el error original de envío no se oculta", async () => {
    newAccount();
    mail.sendMail.mockRejectedValue(SECRET_ERROR());
    await POST(post());
    tokenRepo.delete.mockRejectedValue(prismaError("P1001", `Invalid \`deleteMany()\` where token HASH ${EMAIL}`));
    await expect(runJobs()).resolves.toBeUndefined();
    expect(entries(errSpy).map((e) => e.scope)).toEqual(["auth.verify.mail", "auth.verify.token_cleanup"]);
    expect(entries(errSpy)[0]!.message).toBe("Fallo de envío de correo (code=EENVELOPE, responseCode=550, command=RCPT TO)");
    expect(entries(errSpy)[1]!.message).toBe("Fallo de base de datos (P1001)");
    const out = logs(errSpy).join("\n");
    for (const secret of [EMAIL, "HASH", "deleteMany", sha256(rawTokenFromMail())]) expect(out).not.toContain(secret);
  });

  it("en una cuenta sin verificar el fallo confirmado también limpia exactamente su token", async () => {
    unverified();
    mail.sendMail.mockRejectedValue(new Error("caído"));
    await POST(post()); await runJobs();
    expect(tokenRepo.delete).toHaveBeenCalledWith(tokenRepo.replace.mock.calls[0]![2]);
  });
});

describe("errores de base de datos: se propagan al callback y se registran sin datos", () => {
  it("fallo al consultar el usuario: respuesta 201 igual, error registrado saneado, sin bcrypt ni correo", async () => {
    userRepo.findByEmail.mockRejectedValue(prismaError("P1001", `Can't reach database ${EMAIL} ${PASS}`));
    expect((await POST(post())).status).toBe(201);
    await expect(runJobs()).resolves.toBeUndefined();
    expect(entries(errSpy)).toHaveLength(1);
    expect(entries(errSpy)[0]).toMatchObject({ scope: "auth.register.deferred", message: "Fallo de base de datos (P1001)" });
    for (const secret of [EMAIL, PASS]) expect(logs(errSpy).join("\n")).not.toContain(secret);
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("authService.register propaga los errores de consulta, de creación y de emisión del token (solo el envío se absorbe)", async () => {
    const { authService } = await import("@/services/auth.service");
    userRepo.findByEmail.mockRejectedValueOnce(prismaError("P2024", "timeout"));
    await expect(authService.register({ email: EMAIL, password: PASS })).rejects.toMatchObject({ code: "P2024" });
    userRepo.create.mockRejectedValueOnce(prismaError("P2003", "clave foránea"));
    await expect(authService.register({ email: EMAIL, password: PASS })).rejects.toMatchObject({ code: "P2003" });
    tokenRepo.replace.mockRejectedValueOnce(prismaError("P2002", "token duplicado", { kind: "UniqueConstraintViolation", constraint: { index: "VerificationToken_token_key" }, table: "VerificationToken" }));
    await expect(authService.register({ email: EMAIL, password: PASS })).rejects.toMatchObject({ code: "P2002" });
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("un error que no es de Prisma (p. ej. de bcrypt) también queda registrado y no cambia la respuesta", async () => {
    bcrypt.hash.mockRejectedValueOnce(new Error("Illegal arguments: string, number"));
    expect((await POST(post())).status).toBe(201);
    await runJobs();
    expect(entries(errSpy).map((e) => e.scope)).toEqual(["auth.register.deferred"]);
    expect(userRepo.create).not.toHaveBeenCalled();
  });
});

describe("carrera de creación: solo el P2002 del email se trata como cuenta existente", () => {
  it.each([["adaptador pg (índice)", pgEmailUnique], ["adaptador de Neon (columnas)", neonEmailUnique]])("P2002 del email (%s): sin error, sin token, sin correo (lo envía la solicitud que ganó) y sin log de error", async (_n, make) => {
    newAccount();
    userRepo.create.mockRejectedValue(make());
    await POST(post());
    await expect(runJobs()).resolves.toBeUndefined();
    expect(userRepo.create).toHaveBeenCalledTimes(1);
    expect(tokenRepo.replace).not.toHaveBeenCalled();     // sustituir aquí el token dejaría muerto el enlace del correo de la solicitud ganadora
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["restricción del perfil (UserProfile.userId)", () => uniqueOn({ index: "UserProfile_userId_key" }, "UserProfile")],
    ["clave primaria de User", () => uniqueOn({ index: "User_pkey" }, "User")],
    ["columnas de otra restricción (Neon)", () => uniqueOn({ fields: ["userId"] }, "UserProfile")],
    ["P2002 sin información de la restricción", () => prismaError("P2002", "Unique constraint failed", { kind: "UniqueConstraintViolation" })],
    ["P2002 sin causa del adaptador", () => prismaError("P2002", "Unique constraint failed on the fields: (`email`)")],
    ["otro código de Prisma (P2003)", () => prismaError("P2003", "FK", { kind: "ForeignKeyConstraintViolation", constraint: { index: "User_email_key" }, table: "User" })],
  ])("%s: NO se oculta: se propaga, se registra y no se envía ni se guarda nada", async (_n, make) => {
    newAccount();
    userRepo.create.mockRejectedValue(make());
    expect((await POST(post())).status).toBe(201);        // la respuesta pública no cambia, pero el error queda registrado
    await expect(runJobs()).resolves.toBeUndefined();
    expect(entries(errSpy)).toHaveLength(1);
    expect(entries(errSpy)[0]!.scope).toBe("auth.register.deferred");
    expect(tokenRepo.replace).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
    for (const secret of [EMAIL, PASS]) expect(logs(errSpy).join("\n")).not.toContain(secret);
  });
});
