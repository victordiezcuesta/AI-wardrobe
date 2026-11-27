import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";
import { MailDeadlineError } from "@/lib/mail/failure";
import { TokenOwnerMissingError } from "@/repositories/token.repository";

/**
 * Fase F.4 — atomicidad de tokens con PGlite: lógica, intercalaciones y rollback.
 *
 * LÍMITE IMPORTANTE: PGlite es UNA sola sesión y el cliente de pruebas usa `max: 1` conexión. Aquí «simultáneo» significa que las
 * operaciones se intercalan entre `await`s sobre la misma conexión; una transacción interactiva la retiene y las demás esperan SIN que
 * intervenga ningún bloqueo de PostgreSQL. Estas pruebas demuestran la lógica (qué filas quedan, qué operación gana, qué se revierte), no
 * que el bloqueo `FOR NO KEY UPDATE` o el borrado condicionado funcionen entre conexiones: eso lo hace pg-token-concurrency.test.ts, que
 * necesita un PostgreSQL local de pruebas (TEST_PG_URL).
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], fail: null as null | (() => Error) }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string, subject: string, text: string) => { if (mail.fail) throw mail.fail(); mail.sent.push({ to, subject, text }); } }));

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const hash = (n: string) => sha(`token-${n}`);
const future = (ms = 3_600_000) => new Date(Date.now() + ms);
let t: TestDb;
let tokenRepository: typeof import("@/repositories/token.repository").tokenRepository;
let authService: typeof import("@/services/auth.service").authService;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  ({ tokenRepository } = await import("@/repositories/token.repository"));
  ({ authService } = await import("@/services/auth.service"));
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  mail.sent.length = 0; mail.fail = null;
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "VerificationToken", "Session", "RateLimit" CASCADE`);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const mkUser = (email: string, over: Record<string, unknown> = {}) => t.prisma.user.create({ data: { email, passwordHash: "hash-previo", emailVerified: null, profile: { create: {} }, ...over } });
const rows = (where: Record<string, unknown> = {}) => t.prisma.verificationToken.findMany({ where, orderBy: { token: "asc" } });
const seedToken = (identifier: string, kind: string, h: string, expires = future()) => t.prisma.verificationToken.create({ data: { identifier, kind, token: h, expires } });
const rawFromMail = (i = -1) => /token=([0-9a-f]{64})/.exec(mail.sent.at(i)!.text)![1]!;

describe("replace: reemplazos simultáneos", () => {
  it("N reemplazos simultáneos de la misma cuenta y finalidad: queda exactamente UN token, uno de los emitidos", async () => {
    await mkUser("ana@example.com");
    await seedToken("ana@example.com", "RESET_PASSWORD", hash("previo"));
    const hashes = Array.from({ length: 6 }, (_, i) => hash(`n${i}`));
    await Promise.all(hashes.map((h) => tokenRepository.replace("ana@example.com", "RESET_PASSWORD", h, future())));
    const left = await rows({ identifier: "ana@example.com", kind: "RESET_PASSWORD" });
    expect(left).toHaveLength(1);
    expect(hashes).toContain(left[0]!.token);
  });

  it("dos reemplazos simultáneos sin token previo: un solo token", async () => {
    await mkUser("ana@example.com");
    await Promise.all([hash("a"), hash("b")].map((h) => tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", h, future())));
    expect(await rows({ identifier: "ana@example.com" })).toHaveLength(1);
  });

  it("cuentas distintas: cada una conserva su propio token", async () => {
    await mkUser("ana@example.com"); await mkUser("beto@example.com");
    await Promise.all([
      tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("a1"), future()),
      tokenRepository.replace("beto@example.com", "RESET_PASSWORD", hash("b1"), future()),
      tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("a2"), future()),
      tokenRepository.replace("beto@example.com", "RESET_PASSWORD", hash("b2"), future()),
    ]);
    expect(await rows({ identifier: "ana@example.com" })).toHaveLength(1);
    expect(await rows({ identifier: "beto@example.com" })).toHaveLength(1);
  });

  it("finalidades distintas de una misma cuenta: un token de cada tipo, sin interferirse", async () => {
    await mkUser("ana@example.com");
    await Promise.all([
      tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", hash("v1"), future()),
      tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("r1"), future()),
      tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", hash("v2"), future()),
      tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("r2"), future()),
    ]);
    expect(await rows({ identifier: "ana@example.com", kind: "VERIFY_EMAIL" })).toHaveLength(1);
    expect(await rows({ identifier: "ana@example.com", kind: "RESET_PASSWORD" })).toHaveLength(1);
  });

  it("limpia duplicados heredados de carreras anteriores: tras un reemplazo queda un solo token", async () => {
    await mkUser("ana@example.com");
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("dup1"));
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("dup2"));
    await tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", hash("nuevo"), future());
    expect((await rows({ identifier: "ana@example.com" })).map((r) => r.token)).toEqual([hash("nuevo")]);
  });

  it("conserva TTL, tipo e identificador del token creado", async () => {
    await mkUser("ana@example.com");
    const exp = future(24 * 3_600_000);
    await tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", hash("x"), exp);
    const [r] = await rows();
    expect(r).toMatchObject({ identifier: "ana@example.com", kind: "VERIFY_EMAIL", token: hash("x") });
    expect(r!.expires.getTime()).toBe(exp.getTime());
  });
});

describe("replace: rollback y cuenta inexistente", () => {
  it("si la creación falla, el borrado anterior se REVIERTE: el token previo sigue vivo y el error se propaga", async () => {
    await mkUser("ana@example.com"); await mkUser("beto@example.com");
    await seedToken("ana@example.com", "RESET_PASSWORD", hash("previo"));
    await seedToken("beto@example.com", "RESET_PASSWORD", hash("choque"));
    // El hash «choque» ya existe (token es único): el `create` falla DESPUÉS del `deleteMany`.
    await expect(tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("choque"), future())).rejects.toMatchObject({ code: "P2002" });
    expect((await rows({ identifier: "ana@example.com" })).map((r) => r.token)).toEqual([hash("previo")]);
    expect((await rows({ identifier: "beto@example.com" })).map((r) => r.token)).toEqual([hash("choque")]);
  });

  it("la cuenta ya no existe (p. ej. se eliminó): error propio y NINGÚN token huérfano", async () => {
    await expect(tokenRepository.replace("fantasma@example.com", "VERIFY_EMAIL", hash("h"), future())).rejects.toBeInstanceOf(TokenOwnerMissingError);
    expect(await rows()).toEqual([]);
  });

  it("cuenta eliminada tras tener token: el borrado de cuenta lo elimina y un reemplazo posterior no crea otro", async () => {
    await mkUser("ana@example.com");
    await tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("a"), future());
    await t.prisma.$transaction([t.prisma.verificationToken.deleteMany({ where: { identifier: "ana@example.com" } }), t.prisma.user.delete({ where: { email: "ana@example.com" } })]);
    await expect(tokenRepository.replace("ana@example.com", "RESET_PASSWORD", hash("b"), future())).rejects.toBeInstanceOf(TokenOwnerMissingError);
    expect(await rows()).toEqual([]);
  });
});

describe("consume: consumos simultáneos", () => {
  it("dos consumos simultáneos del mismo token: exactamente uno lo consume y el otro recibe null", async () => {
    await mkUser("ana@example.com");
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("t"));
    const results = await Promise.all([tokenRepository.consume(hash("t"), "VERIFY_EMAIL"), tokenRepository.consume(hash("t"), "VERIFY_EMAIL")]);
    expect(results.filter((r) => r === "ana@example.com")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  it("muchos consumos simultáneos: un único ganador", async () => {
    await mkUser("ana@example.com");
    await seedToken("ana@example.com", "RESET_PASSWORD", hash("t"));
    const results = await Promise.all(Array.from({ length: 8 }, () => tokenRepository.consume(hash("t"), "RESET_PASSWORD")));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("consumos de tokens distintos: todos tienen éxito", async () => {
    await mkUser("ana@example.com"); await mkUser("beto@example.com");
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("a")); await seedToken("beto@example.com", "VERIFY_EMAIL", hash("b"));
    const results = await Promise.all([tokenRepository.consume(hash("a"), "VERIFY_EMAIL"), tokenRepository.consume(hash("b"), "VERIFY_EMAIL")]);
    expect(results.sort()).toEqual(["ana@example.com", "beto@example.com"]);
    expect(await rows()).toEqual([]);
  });

  it("consumo simultáneo con un reemplazo: nunca queda más de un token, y un consumo con éxito solo ocurre sobre el token que existía", async () => {
    await mkUser("ana@example.com");
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("viejo"));
    const [consumed] = await Promise.all([
      tokenRepository.consume(hash("viejo"), "VERIFY_EMAIL"),
      tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", hash("nuevo"), future()),
    ]);
    expect([null, "ana@example.com"]).toContain(consumed);
    expect((await rows()).map((r) => r.token)).toEqual([hash("nuevo")]);   // sea cual sea el orden, solo queda el nuevo
  });
});

describe("consume: token no válido (todos devuelven null; la fila no se toca salvo que sea consumida)", () => {
  it("inexistente", async () => { expect(await tokenRepository.consume(hash("no-existe"), "VERIFY_EMAIL")).toBeNull(); });
  it("caducado: null, y la fila NO se borra (como antes)", async () => {
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("c"), new Date(Date.now() - 1000));
    expect(await tokenRepository.consume(hash("c"), "VERIFY_EMAIL")).toBeNull();
    expect(await rows()).toHaveLength(1);
  });
  it("de otra finalidad: null, y la fila NO se borra", async () => {
    await seedToken("ana@example.com", "RESET_PASSWORD", hash("k"));
    expect(await tokenRepository.consume(hash("k"), "VERIFY_EMAIL")).toBeNull();
    expect(await rows()).toHaveLength(1);
  });
  it("ya consumido", async () => {
    await seedToken("ana@example.com", "VERIFY_EMAIL", hash("u"));
    expect(await tokenRepository.consume(hash("u"), "VERIFY_EMAIL")).toBe("ana@example.com");
    expect(await tokenRepository.consume(hash("u"), "VERIFY_EMAIL")).toBeNull();
  });
});

describe("servicios: un solo uso y el mismo error para todos los casos", () => {
  const INVALID = { code: "INVALID_TOKEN", status: 400, message: "Enlace no válido o caducado" };

  it("dos verifyEmail simultáneos con el mismo token: uno verifica la cuenta y el otro recibe INVALID_TOKEN", async () => {
    await mkUser("ana@example.com");
    const raw = "a".repeat(64);
    await seedToken("ana@example.com", "VERIFY_EMAIL", sha(raw));
    const settled = await Promise.allSettled([authService.verifyEmail(raw), authService.verifyEmail(raw)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject(INVALID);
    expect((await t.prisma.user.findUnique({ where: { email: "ana@example.com" } }))!.emailVerified).toBeInstanceOf(Date);
  });

  it("dos resetPassword simultáneos con el mismo token y contraseñas distintas: solo una se aplica y la otra recibe INVALID_TOKEN", async () => {
    await mkUser("ana@example.com", { emailVerified: new Date() });
    const raw = "b".repeat(64);
    await seedToken("ana@example.com", "RESET_PASSWORD", sha(raw));
    const settled = await Promise.allSettled([authService.resetPassword(raw, "Primera-clave-1A"), authService.resetPassword(raw, "Segunda-clave-2B")]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect((settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(INVALID);
    const stored = (await t.prisma.user.findUnique({ where: { email: "ana@example.com" } }))!.passwordHash!;
    const first = await bcrypt.compare("Primera-clave-1A", stored); const second = await bcrypt.compare("Segunda-clave-2B", stored);
    expect([first, second].filter(Boolean)).toHaveLength(1);              // exactamente una de las dos contraseñas quedó guardada
  }, 60_000);

  it("inexistente, caducado, de otra finalidad y ya consumido: el MISMO error (código, estado y mensaje) en verifyEmail y resetPassword", async () => {
    await seedToken("ana@example.com", "VERIFY_EMAIL", sha("c".repeat(64)), new Date(Date.now() - 1000));
    await seedToken("ana@example.com", "RESET_PASSWORD", sha("d".repeat(64)));
    for (const raw of ["z".repeat(64), "c".repeat(64), "d".repeat(64)]) await expect(authService.verifyEmail(raw)).rejects.toMatchObject(INVALID);
    await mkUser("ana@example.com");
    await expect(authService.resetPassword("d".repeat(64), "Nueva-clave-1A")).resolves.toBeUndefined();
    await expect(authService.resetPassword("d".repeat(64), "Nueva-clave-1A")).rejects.toMatchObject(INVALID);   // ya consumido
    for (const raw of ["z".repeat(64), "c".repeat(64)]) await expect(authService.resetPassword(raw, "Nueva-clave-1A")).rejects.toMatchObject(INVALID);
  }, 60_000);
});

describe("regresión de los flujos de registro, verificación y recuperación (F.2 / F.3 intactos)", () => {
  it("registro → correo → verificación: el token se emite con 24 h, verifica la cuenta, se consume y no se reutiliza", async () => {
    const t0 = Date.now();
    await authService.register({ email: "nueva@example.com", password: "Abcdefghi1-x", name: "Nueva" });
    const [row] = await rows({ identifier: "nueva@example.com" });
    expect(row).toMatchObject({ kind: "VERIFY_EMAIL", token: sha(rawFromMail()) });
    expect(row!.expires.getTime() - t0).toBeGreaterThanOrEqual(24 * 3_600_000 - 50);
    expect(mail.sent[0]!.text).toMatch(/^Confirma tu cuenta: http:\/\/localhost:3000\/verify-email\?token=[0-9a-f]{64} \nEl enlace caduca en 24 horas\.$/);
    await authService.verifyEmail(rawFromMail());
    expect((await t.prisma.user.findUnique({ where: { email: "nueva@example.com" } }))!.emailVerified).toBeInstanceOf(Date);
    expect(await rows()).toEqual([]);
    await expect(authService.verifyEmail(rawFromMail())).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  }, 30_000);

  it("recuperación → correo → restablecimiento: token de 1 h, cambia la contraseña y no se reutiliza", async () => {
    await mkUser("ana@example.com", { emailVerified: new Date() });
    const t0 = Date.now();
    await authService.requestReset("ana@example.com");
    const [row] = await rows({ identifier: "ana@example.com" });
    expect(row).toMatchObject({ kind: "RESET_PASSWORD", token: sha(rawFromMail()) });
    expect(row!.expires.getTime() - t0).toBeGreaterThanOrEqual(3_600_000 - 50);
    expect(row!.expires.getTime() - t0).toBeLessThanOrEqual(3_600_000 + 5_000);
    await authService.resetPassword(rawFromMail(), "Nueva-clave-9Z");
    expect(await bcrypt.compare("Nueva-clave-9Z", (await t.prisma.user.findUnique({ where: { email: "ana@example.com" } }))!.passwordHash!)).toBe(true);
    await expect(authService.resetPassword(rawFromMail(), "Otra-clave-8Y")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  }, 30_000);

  it("fallo SMTP confirmado: se borra exactamente el token recién creado; plazo agotado: se conserva", async () => {
    await mkUser("ana@example.com", { emailVerified: new Date() });
    mail.fail = () => Object.assign(new Error("rechazado"), { code: "EENVELOPE" });
    await authService.requestReset("ana@example.com");
    expect(await rows()).toEqual([]);
    mail.fail = () => new MailDeadlineError();
    await authService.requestReset("ana@example.com");
    expect(await rows({ identifier: "ana@example.com" })).toHaveLength(1);
  });

  it("una solicitud de recuperación repetida sustituye al token anterior (un solo token activo) y el enlace anterior deja de valer", async () => {
    await mkUser("ana@example.com", { emailVerified: new Date() });
    await authService.requestReset("ana@example.com");
    const first = rawFromMail();
    await authService.requestReset("ana@example.com");
    expect(await rows({ identifier: "ana@example.com" })).toHaveLength(1);
    await expect(authService.resetPassword(first, "Nueva-clave-9Z")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expect(authService.resetPassword(rawFromMail(), "Nueva-clave-9Z")).resolves.toBeUndefined();
  }, 30_000);
});
