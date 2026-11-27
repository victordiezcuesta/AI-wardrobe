import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase F.2 — transporte de correo: timeouts explícitos (compartidos con registro y verificación), plazo total acotado bajo el
 * `maxDuration` de la ruta y ninguna traza del enlace o el token en producción sin SMTP. nodemailer y el entorno, simulados: sin SMTP real.
 */
const nm = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn(), createTransport: vi.fn() }));
const envHolder = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("nodemailer", () => ({ default: { createTransport: nm.createTransport } }));
vi.mock("@/lib/env", () => ({ env: () => envHolder.value }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hash-simulado"), compare: vi.fn(async () => false) } }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const userRepo = vi.hoisted(() => ({ findByEmail: vi.fn(), create: vi.fn(async () => undefined) }));
const tokenRepo = vi.hoisted(() => ({ replace: vi.fn(async () => undefined), find: vi.fn(), delete: vi.fn(async () => undefined) }));
vi.mock("@/repositories/user.repository", () => ({ userRepository: userRepo }));
vi.mock("@/repositories/session.repository", () => ({ sessionRepository: {} }));
vi.mock("@/repositories/token.repository", () => ({ tokenRepository: tokenRepo }));

const SMTP = { SMTP_HOST: "smtp.test", SMTP_PORT: 587, SMTP_USER: "u", SMTP_PASSWORD: "p", EMAIL_FROM: "AI Wardrobe <no-reply@test>", NEXT_PUBLIC_APP_URL: "https://app.test" };
const NO_SMTP = { EMAIL_FROM: "x <x@test>", NEXT_PUBLIC_APP_URL: "https://app.test", SMTP_PORT: 587 };
const LINK = "https://app.test/reset-password?token=" + "a".repeat(64);

beforeEach(() => {
  nm.sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  nm.close.mockReset();
  nm.createTransport.mockReset().mockImplementation(() => ({ sendMail: nm.sendMail, close: nm.close }));
  envHolder.value = { ...SMTP };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("sendMail con SMTP configurado", () => {
  it("crea el transporte con los timeouts explícitos y los datos de siempre", async () => {
    const { sendMail, SMTP_TIMEOUTS } = await import("@/lib/mail");
    await sendMail("ana@example.com", "Asunto", "Texto", "<p>Texto</p>");
    expect(nm.createTransport).toHaveBeenCalledTimes(1);
    expect(nm.createTransport).toHaveBeenCalledWith({
      host: "smtp.test", port: 587, secure: false, auth: { user: "u", pass: "p" },
      connectionTimeout: SMTP_TIMEOUTS.connectionTimeout, greetingTimeout: SMTP_TIMEOUTS.greetingTimeout, socketTimeout: SMTP_TIMEOUTS.socketTimeout,
    });
    for (const v of Object.values(SMTP_TIMEOUTS)) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThan(0); }
    expect(nm.sendMail).toHaveBeenCalledWith({ from: SMTP.EMAIL_FROM, to: "ana@example.com", subject: "Asunto", text: "Texto", html: "<p>Texto</p>" });
    expect(nm.close).not.toHaveBeenCalled();      // el camino sano no cambia
  });

  it("puerto 465 → conexión segura; sin usuario → sin autenticación", async () => {
    envHolder.value = { ...SMTP, SMTP_PORT: 465, SMTP_USER: undefined };
    const { sendMail } = await import("@/lib/mail");
    await sendMail("a@b.co", "s", "t");
    expect(nm.createTransport.mock.calls[0]![0]).toMatchObject({ port: 465, secure: true, auth: undefined });
  });

  it("los plazos son coherentes: cada fase ≤ plazo total < maxDuration de la ruta de recuperación (con margen)", async () => {
    const { SMTP_TIMEOUTS, SEND_DEADLINE_MS } = await import("@/lib/mail");
    for (const v of Object.values(SMTP_TIMEOUTS)) expect(v).toBeLessThanOrEqual(SEND_DEADLINE_MS);
    const route = readFileSync(path.join(process.cwd(), "src/app/api/auth/forgot-password/route.ts"), "utf8");
    const maxDuration = Number(/^export const maxDuration = (\d+);/m.exec(route)?.[1]);
    expect(Number.isInteger(maxDuration)).toBe(true);
    expect(maxDuration * 1000 - SEND_DEADLINE_MS).toBeGreaterThanOrEqual(5_000); // margen para la consulta de usuario y el token
  });

  it("un error del transporte se propaga tal cual y se hace la limpieza del transportador", async () => {
    const boom = Object.assign(new Error("rechazado"), { code: "EENVELOPE" });
    nm.sendMail.mockRejectedValueOnce(boom);
    const { sendMail } = await import("@/lib/mail");
    await expect(sendMail("a@b.co", "s", "t")).rejects.toBe(boom);
    expect(nm.close).toHaveBeenCalledTimes(1);
  });

  it("un servidor que no responde: la ESPERA termina al llegar el plazo total con MailDeadlineError, y no queda ningún temporizador", async () => {
    vi.useFakeTimers();
    nm.sendMail.mockReturnValueOnce(new Promise(() => undefined));
    const { sendMail, SEND_DEADLINE_MS } = await import("@/lib/mail");
    const { MailDeadlineError } = await import("@/lib/mail/failure");
    const result = sendMail("a@b.co", "s", "t").then(() => "ok", (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS - 1);
    expect(nm.close).not.toHaveBeenCalled();     // antes del plazo no se hace nada
    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(err).toBeInstanceOf(MailDeadlineError);
    expect(err).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("al vencer el plazo solo se hace la limpieza del transportador: no hay forma de cancelar el envío en curso, que sigue pendiente", async () => {
    vi.useFakeTimers();
    let finishLate!: (v: unknown) => void;
    nm.sendMail.mockReturnValueOnce(new Promise((res) => { finishLate = res; }));
    const { sendMail, SEND_DEADLINE_MS } = await import("@/lib/mail");
    const result = sendMail("a@b.co", "s", "t").then(() => "ok", (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
    await result;
    expect(nm.close).toHaveBeenCalledTimes(1);   // limpieza del transportador (no aborta nada): es la única operación sobre el transporte
    expect(nm.sendMail).toHaveBeenCalledTimes(1);
    finishLate({ messageId: "tarde" });          // el envío abandonado puede completarse después sin efectos (ni rechazos sin manejar)
    await vi.advanceTimersByTimeAsync(0);
  });

  it("los timeouts propios de nodemailer (ETIMEDOUT de conexión o de socket) NO son el plazo total: se propagan tal cual, como fallo confirmado", async () => {
    const { sendMail } = await import("@/lib/mail");
    const { MailDeadlineError } = await import("@/lib/mail/failure");
    const own = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" });
    nm.sendMail.mockRejectedValueOnce(own);
    const err = await sendMail("a@b.co", "s", "t").then(() => null, (e: unknown) => e);
    expect(err).toBe(own);
    expect(err).not.toBeInstanceOf(MailDeadlineError);
  });

  it("un envío correcto cancela el temporizador del plazo (no retiene el proceso)", async () => {
    vi.useFakeTimers();
    const { sendMail } = await import("@/lib/mail");
    await sendMail("a@b.co", "s", "t");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("sin SMTP configurado", () => {
  beforeEach(() => { envHolder.value = { ...NO_SMTP }; });
  const spies = () => ({ info: vi.spyOn(console, "info").mockImplementation(() => undefined), log: vi.spyOn(console, "log").mockImplementation(() => undefined), warn: vi.spyOn(console, "warn").mockImplementation(() => undefined), error: vi.spyOn(console, "error").mockImplementation(() => undefined) });
  const everything = (s: ReturnType<typeof spies>) => JSON.stringify([s.info, s.log, s.warn, s.error].map((x) => x.mock.calls));

  it("producción: no imprime destinatario, asunto, texto, enlace ni token; solo un diagnóstico de configuración, y no envía", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const s = spies();
    const { sendMail } = await import("@/lib/mail");
    await expect(sendMail("ana@example.com", "Restablece tu contraseña", `Crea una nueva contraseña: ${LINK} \nEl enlace caduca en 1 hora.`)).resolves.toBeUndefined();
    const out = everything(s);
    for (const secret of ["ana@example.com", "token=", LINK, "a".repeat(64), "Restablece tu contraseña", "Crea una nueva contraseña"]) expect(out).not.toContain(secret);
    expect(s.info).not.toHaveBeenCalled();
    expect(s.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(s.error.mock.calls[0]![0]))).toEqual({ level: "error", scope: "mail", message: "SMTP_HOST no configurado: el correo no se ha enviado" });
    expect(nm.createTransport).not.toHaveBeenCalled();
  });

  it.each(["development", "test"])("%s: se mantiene el comportamiento actual (el enlace se imprime en consola)", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const s = spies();
    const { sendMail } = await import("@/lib/mail");
    await sendMail("ana@example.com", "Asunto", `Enlace: ${LINK}`);
    expect(s.info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(s.info.mock.calls[0]![0]))).toEqual({ level: "info", scope: "mail", to: "ana@example.com", subject: "Asunto", text: `Enlace: ${LINK}` });
    expect(s.error).not.toHaveBeenCalled();
  });
});

describe("registro y verificación con los nuevos timeouts (sin regresiones)", () => {
  it("registro de una cuenta nueva: crea el usuario, emite el token y envía el mismo correo de verificación por el transporte con timeouts", async () => {
    userRepo.findByEmail.mockResolvedValueOnce(null);
    const { authService } = await import("@/services/auth.service");
    const { SMTP_TIMEOUTS } = await import("@/lib/mail");
    await authService.register({ email: "nueva@example.com", password: "Abcdefghi1", name: "Nueva" });
    expect(userRepo.create).toHaveBeenCalledWith({ email: "nueva@example.com", name: "Nueva", passwordHash: "hash-simulado" });
    expect(tokenRepo.replace).toHaveBeenCalledWith("nueva@example.com", "VERIFY_EMAIL", expect.stringMatching(/^[0-9a-f]{64}$/), expect.any(Date));
    expect(nm.createTransport.mock.calls[0]![0]).toMatchObject(SMTP_TIMEOUTS);
    const [mail] = nm.sendMail.mock.calls[0] as [{ to: string; subject: string; text: string }];
    expect(mail.to).toBe("nueva@example.com");
    expect(mail.subject).toBe("Confirma tu email en AI Wardrobe");
    expect(mail.text).toMatch(/^Confirma tu cuenta: https:\/\/app\.test\/verify-email\?token=[0-9a-f]{64} \nEl enlace caduca en 24 horas\.$/);
  });

  it("reenvío de verificación a una cuenta sin confirmar: mismo correo; un fallo SMTP ya no se propaga (F.3: el registro corre en after()), se registra saneado y se borra el token", async () => {
    // Antes (F.2.1) este fallo se propagaba al 500 de la petición. Ahora el trabajo corre tras responder: un fallo de envío no puede cambiar
    // la respuesta (sería una vía de enumeración); queda en el log, sin datos, y se limpia el token exacto. Ver register-anti-enumeration.test.ts.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    userRepo.findByEmail.mockResolvedValue({ email: "x@example.com", emailVerified: null });
    const { authService } = await import("@/services/auth.service");
    await authService.register({ email: "x@example.com", password: "Abcdefghi1" });
    expect(nm.sendMail).toHaveBeenCalledTimes(1);
    expect((nm.sendMail.mock.calls[0]![0] as { subject: string }).subject).toBe("Confirma tu email en AI Wardrobe");
    expect(errSpy).not.toHaveBeenCalled();
    nm.sendMail.mockRejectedValueOnce(Object.assign(new Error("caído x@example.com"), { code: "ECONNECTION" }));
    await expect(authService.register({ email: "x@example.com", password: "Abcdefghi1" })).resolves.toBeUndefined();
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("auth.verify.mail");
    expect(logged).toContain("code=ECONNECTION");
    expect(logged).not.toContain("x@example.com");
    const storedHash = (tokenRepo.replace.mock.calls.at(-1) as unknown[])[2] as string;
    expect(tokenRepo.delete).toHaveBeenCalledWith(storedHash);
  });
});
