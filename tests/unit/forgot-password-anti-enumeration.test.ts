import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailDeadlineError } from "@/lib/mail/failure";

/**
 * Fase F.2 — recuperación de contraseña sin enumeración de cuentas. Ruta REAL (`handler`, Zod, orden de límites) + `authService` REAL;
 * simulados: `after` (se captura el callback y lo ejecuta la prueba cuando quiere), los límites, los repositorios y el envío de correo.
 * Sin base de datos, sin SMTP, sin red. La respuesta pública no puede depender de si la cuenta existe ni de si el correo salió.
 */
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[], order: [] as string[] }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.order.push("after"); bg.jobs.push(fn); } }));
vi.mock("@/lib/rate-limit/ip", () => ({ rateLimitByIp: vi.fn(async () => { bg.order.push("ip"); }) }));
vi.mock("@/lib/rate-limit/email", () => ({ rateLimitByEmail: vi.fn(async () => { bg.order.push("email"); }) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const userRepo = vi.hoisted(() => ({ findByEmail: vi.fn() }));
const tokenRepo = vi.hoisted(() => ({ replace: vi.fn(), find: vi.fn(), delete: vi.fn() }));
const mail = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("@/repositories/user.repository", () => ({ userRepository: userRepo }));
vi.mock("@/repositories/session.repository", () => ({ sessionRepository: {} }));
vi.mock("@/repositories/token.repository", () => ({ tokenRepository: tokenRepo }));
vi.mock("@/lib/mail", () => ({ sendMail: mail.sendMail }));

const EMAIL = "ana@example.com";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const post = (body: unknown = { email: EMAIL }) => new Request("http://localhost:3000/api/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const snapshot = async (res: Response) => ({ status: res.status, body: await res.text(), headers: [...res.headers].sort() });
const runJobs = async () => { for (const j of bg.jobs.splice(0)) await j(); };
const rawTokenFromMail = () => /token=([0-9a-f]{64})/.exec(String((mail.sendMail.mock.calls[0] as unknown[])[2]))![1]!;
const logs = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => String(c[0]));
const prismaError = (code: string, message: string) => Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code });

let POST: (req: Request) => Promise<Response>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  bg.jobs.length = 0; bg.order.length = 0;
  userRepo.findByEmail.mockReset(); tokenRepo.replace.mockReset().mockResolvedValue(undefined); tokenRepo.delete.mockReset().mockResolvedValue(undefined);
  mail.sendMail.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test"); vi.stubEnv("DATABASE_URL", "postgres://x"); vi.stubEnv("AUTH_SECRET", "x".repeat(32));
  vi.stubEnv("CLOUDINARY_CLOUD_NAME", "d"); vi.stubEnv("CLOUDINARY_API_KEY", "k"); vi.stubEnv("CLOUDINARY_API_SECRET", "s");
  vi.stubEnv("OPENROUTER_API_KEY", "o"); vi.stubEnv("POLLINATIONS_API_KEY", "p");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  POST = ((await import("@/app/api/auth/forgot-password/route")) as { POST: (req: Request) => Promise<Response> }).POST;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const withUser = () => userRepo.findByEmail.mockResolvedValue({ email: EMAIL, passwordHash: "h", emailVerified: new Date() });

describe("respuesta pública equivalente", () => {
  it("cuenta existente, inexistente, sin contraseña y con fallo SMTP: mismo estado, cuerpo y cabeceras", async () => {
    const results: Awaited<ReturnType<typeof snapshot>>[] = [];
    const scenario = async (setup: () => void) => { setup(); results.push(await snapshot(await POST(post()))); await runJobs(); };
    await scenario(() => withUser());
    await scenario(() => userRepo.findByEmail.mockResolvedValue(null));
    await scenario(() => userRepo.findByEmail.mockResolvedValue({ email: EMAIL, passwordHash: null, emailVerified: null }));
    await scenario(() => { withUser(); mail.sendMail.mockRejectedValue(Object.assign(new Error(`rechazado ${EMAIL}`), { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" })); });
    await scenario(() => { withUser(); mail.sendMail.mockRejectedValue(new Error("caído")); tokenRepo.delete.mockRejectedValue(new Error("también falla la limpieza")); });
    await scenario(() => { withUser(); mail.sendMail.mockRejectedValue(new MailDeadlineError()); });   // plazo total: entrega incierta
    expect(results).toHaveLength(6);
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.status).toBe(200);
    expect(JSON.parse(results[0]!.body)).toEqual({ ok: true, message: "Si la cuenta existe, recibirás un enlace." });
  });
});

describe("el camino síncrono no depende de la cuenta (estructural)", () => {
  it("antes de responder no se consulta el usuario, no se emite token y no se envía correo; todo queda para `after()`", async () => {
    withUser();
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
    expect(tokenRepo.replace).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(bg.jobs).toHaveLength(1);                       // exactamente un trabajo diferido, sin promesas sueltas
    await runJobs();
    expect(userRepo.findByEmail).toHaveBeenCalledWith(EMAIL);
    expect(tokenRepo.replace).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it("la respuesta no espera a la consulta de usuario ni al envío, aunque ambos no terminen nunca", async () => {
    userRepo.findByEmail.mockReturnValue(new Promise(() => undefined));
    const stuck = await POST(post());
    expect(stuck.status).toBe(200);
    userRepo.findByEmail.mockResolvedValue({ email: EMAIL, passwordHash: "h", emailVerified: null });
    mail.sendMail.mockReturnValue(new Promise(() => undefined));
    const stuckMail = await POST(post());
    expect(stuckMail.status).toBe(200);
    expect(await snapshot(stuck)).toEqual({ ...(await snapshot(stuckMail)) });
  });

  it("el orden es: límite por IP → validación → límite por email → trabajo diferido → respuesta", async () => {
    await POST(post());
    expect(bg.order).toEqual(["ip", "email", "after"]);
  });

  it("si un límite rechaza (429) o la validación falla (422), no se programa nada y no se toca el usuario", async () => {
    const { rateLimitByEmail } = await import("@/lib/rate-limit/email");
    const { tooMany } = await import("@/lib/errors");
    vi.mocked(rateLimitByEmail).mockRejectedValueOnce(tooMany(30));
    const limited = await POST(post());
    expect(limited.status).toBe(429);
    const invalid = await POST(post({ email: "no-es-un-email" }));
    expect(invalid.status).toBe(422);
    expect(bg.jobs).toHaveLength(0);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });
});

describe("fallo SMTP en el trabajo diferido", () => {
  const SECRET_ERROR = () => Object.assign(new Error(`Recipient address rejected: ${EMAIL} url=https://app.test/reset-password?token=XYZ`), {
    code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: `550 ${EMAIL}`, rejected: [EMAIL],
  });

  it("no lanza, se registra saneado (solo códigos) y no aparece ningún dato sensible en el log", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(SECRET_ERROR());
    await POST(post());
    await expect(runJobs()).resolves.toBeUndefined();
    const raw = rawTokenFromMail();
    const out = logs(errSpy).join("\n");
    const entry = logs(errSpy).map((l) => JSON.parse(l) as { scope: string; message: string }).find((l) => l.scope === "auth.reset.mail");
    expect(entry?.message).toBe("Fallo de envío de correo (code=EENVELOPE, responseCode=550, command=RCPT TO)");
    for (const secret of [EMAIL, raw, sha256(raw), "token=", "reset-password", "Recipient address rejected", "app.test"]) expect(out).not.toContain(secret);
  });

  it("el token recién creado se elimina: el mismo hash que se guardó, nunca el token en claro", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(SECRET_ERROR());
    await POST(post()); await runJobs();
    const raw = rawTokenFromMail();
    expect(tokenRepo.replace).toHaveBeenCalledTimes(1);
    const storedHash = tokenRepo.replace.mock.calls[0]![2] as string;
    expect(storedHash).toBe(sha256(raw));
    expect(tokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(tokenRepo.delete).toHaveBeenCalledWith(storedHash);
    expect(tokenRepo.delete).not.toHaveBeenCalledWith(raw);
  });

  it("si también falla la limpieza, se registran AMBOS fallos saneados (el segundo solo con el código de base de datos)", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(SECRET_ERROR());
    await POST(post());
    tokenRepo.delete.mockRejectedValue(prismaError("P1001", `Invalid \`prisma.verificationToken.deleteMany()\` where: { token: "HASH" } ${EMAIL}`));
    await expect(runJobs()).resolves.toBeUndefined();
    const entries = logs(errSpy).map((l) => JSON.parse(l) as { scope: string; message: string });
    expect(entries.map((e) => e.scope)).toEqual(["auth.reset.mail", "auth.reset.token_cleanup"]);
    expect(entries[1]!.message).toBe("Fallo de base de datos (P1001)");
    const out = logs(errSpy).join("\n");
    for (const secret of [EMAIL, "HASH", "deleteMany", "where", sha256(rawTokenFromMail())]) expect(out).not.toContain(secret);
  });

  it("un error de limpieza que no es de Prisma tampoco filtra su mensaje", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(new Error("caído"));
    await POST(post());
    tokenRepo.delete.mockRejectedValue(new Error(`fallo con ${EMAIL} y el hash`));
    await runJobs();
    expect(logs(errSpy).join("\n")).not.toContain(EMAIL);
    expect(logs(errSpy).map((l) => JSON.parse(l).message)).toContain("Fallo de base de datos");
  });
});

describe("plazo total de envío: entrega incierta (F.2.1)", () => {
  const entries = () => logs(errSpy).map((l) => JSON.parse(l) as { scope: string; message: string });

  it("el token NO se borra (el correo puede llegar tarde y su enlace debe seguir siendo válido) y se registra como entrega incierta", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(new MailDeadlineError());
    const res = await POST(post());
    expect(res.status).toBe(200);
    await expect(runJobs()).resolves.toBeUndefined();
    expect(tokenRepo.replace).toHaveBeenCalledTimes(1);
    expect(tokenRepo.delete).not.toHaveBeenCalled();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ level: "error", scope: "auth.reset.mail_uncertain", message: "Entrega de correo incierta (plazo de envío agotado)" });
  });

  it("el log de la entrega incierta no contiene destinatario, token, hash, enlace ni mensajes SMTP", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(Object.assign(new MailDeadlineError(), { to: EMAIL, url: "https://app.test/reset-password?token=XYZ", response: `550 ${EMAIL}` }));
    await POST(post()); await runJobs();
    const raw = /token=([0-9a-f]{64})/.exec(String((mail.sendMail.mock.calls[0] as unknown[])[2]))![1]!;
    const out = logs(errSpy).join("\n");
    for (const secret of [EMAIL, raw, sha256(raw), "token=", "reset-password", "app.test", "Tiempo de envío agotado"]) expect(out).not.toContain(secret);
  });

  it("un timeout PROPIO de nodemailer (ETIMEDOUT de conexión) es un fallo confirmado: se borra exactamente el token recién creado", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" }));
    await POST(post()); await runJobs();
    const storedHash = tokenRepo.replace.mock.calls[0]![2] as string;
    expect(tokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(tokenRepo.delete).toHaveBeenCalledWith(storedHash);
    expect(entries().map((e) => e.scope)).toEqual(["auth.reset.mail"]);
    expect(entries()[0]!.message).toBe("Fallo de envío de correo (code=ETIMEDOUT, command=CONN)");
  });

  it("un objeto que imita el plazo (mismo name o code) tampoco conserva el token", async () => {
    withUser();
    mail.sendMail.mockRejectedValue(Object.assign(new Error("x"), { name: "MailDeadlineError", code: "ETIMEDOUT", command: "SEND" }));
    await POST(post()); await runJobs();
    expect(tokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(entries().map((e) => e.scope)).toEqual(["auth.reset.mail"]);
  });

  it("con entrega incierta no se intenta ninguna limpieza (un fallo de borrado no puede producirse ni registrarse); un reintento emite un token nuevo y no toca el anterior", async () => {
    withUser();
    tokenRepo.delete.mockRejectedValue(new Error("no debe llamarse"));
    mail.sendMail.mockRejectedValueOnce(new MailDeadlineError()).mockResolvedValueOnce(undefined);
    await POST(post()); await runJobs();
    await POST(post()); await runJobs();
    expect(tokenRepo.delete).not.toHaveBeenCalled();
    const [first, second] = tokenRepo.replace.mock.calls.map((c) => c[2] as string);
    expect(first).not.toBe(second);
    expect(entries().map((e) => e.scope)).toEqual(["auth.reset.mail_uncertain"]);
  });
});

describe("los errores internos no se ocultan", () => {
  it("fallo de base de datos al buscar el usuario: la respuesta pública es la de siempre, pero queda registrado (saneado) y no se envía nada", async () => {
    userRepo.findByEmail.mockRejectedValue(prismaError("P1001", `Can't reach database ${EMAIL}`));
    const res = await POST(post());
    expect(res.status).toBe(200);
    await expect(runJobs()).resolves.toBeUndefined();
    const entry = logs(errSpy).map((l) => JSON.parse(l) as { scope: string; message: string }).find((l) => l.scope === "auth.forgot.deferred");
    expect(entry?.message).toBe("Fallo de base de datos (P1001)");
    expect(logs(errSpy).join("\n")).not.toContain(EMAIL);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("requestReset propaga los errores de base de datos (consulta y emisión del token): solo el envío se absorbe", async () => {
    const { authService } = await import("@/services/auth.service");
    userRepo.findByEmail.mockRejectedValueOnce(prismaError("P2024", "timeout"));
    await expect(authService.requestReset(EMAIL)).rejects.toMatchObject({ code: "P2024" });
    withUser();
    tokenRepo.replace.mockRejectedValueOnce(prismaError("P2002", "duplicado"));
    await expect(authService.requestReset(EMAIL)).rejects.toMatchObject({ code: "P2002" });
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(tokenRepo.delete).not.toHaveBeenCalled();     // no hay token que limpiar si no se creó
  });
});

describe("el token mantiene su caducidad y sus restricciones", () => {
  it("1 hora de vida exacta, 32 bytes aleatorios, solo se guarda el hash y el enlace lleva el token en claro", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
    withUser();
    await POST(post()); await runJobs();
    const [identifier, kind, hash, expires] = tokenRepo.replace.mock.calls[0] as [string, string, string, Date];
    expect(identifier).toBe(EMAIL);
    expect(kind).toBe("RESET_PASSWORD");
    expect(expires.toISOString()).toBe("2026-06-01T11:00:00.000Z");
    const [to, subject, text] = mail.sendMail.mock.calls[0] as [string, string, string];
    const raw = /token=([0-9a-f]{64})$/m.exec(text.split(" \n")[0]!)?.[1];
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256(raw!));
    expect(hash).not.toBe(raw);
    expect(to).toBe(EMAIL);
    expect(subject).toBe("Restablece tu contraseña");
    expect(text).toBe(`Crea una nueva contraseña: https://app.test/reset-password?token=${raw} \nEl enlace caduca en 1 hora.`);
  });

  it("cada solicitud usa un token distinto (sin reutilización) y no hay limpieza cuando el envío va bien", async () => {
    withUser();
    await POST(post()); await runJobs();
    await POST(post()); await runJobs();
    const hashes = tokenRepo.replace.mock.calls.map((c) => c[2] as string);
    expect(new Set(hashes).size).toBe(2);
    expect(tokenRepo.delete).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("reintento tras un fallo de envío: se vuelve a emitir un token nuevo y se limpia solo el del intento fallido", async () => {
    withUser();
    mail.sendMail.mockRejectedValueOnce(new Error("caído")).mockResolvedValueOnce(undefined);
    await POST(post()); await runJobs();
    await POST(post()); await runJobs();
    const [first, second] = tokenRepo.replace.mock.calls.map((c) => c[2] as string);
    expect(first).not.toBe(second);
    expect(tokenRepo.delete).toHaveBeenCalledTimes(1);
    expect(tokenRepo.delete).toHaveBeenCalledWith(first);
  });
});
