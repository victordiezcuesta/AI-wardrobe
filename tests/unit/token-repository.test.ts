import { beforeEach, describe, expect, it, vi } from "vitest";
import { tokenRepository, TokenOwnerMissingError } from "@/repositories/token.repository";

/**
 * Fase F.4 — repositorio de tokens con un cliente de Prisma SIMULADO: comprueba la secuencia exacta de operaciones, que dentro de la
 * transacción solo se usa `tx` y que el consumo exige exactamente una fila borrada. La concurrencia real se prueba en PGlite
 * (auth-token-atomicity) y con PostgreSQL real (pg-token-concurrency); aquí no se afirma nada sobre concurrencia.
 */
const trace = vi.hoisted(() => ({ calls: [] as string[], lockSql: "", lockValues: [] as unknown[], lockRows: [{ "?column?": 1 }] as unknown[] }));
const fail = (name: string) => () => { throw new Error(`${name} llamado FUERA de la transacción`); };
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  verificationToken: { deleteMany: vi.fn(), create: vi.fn() },
}));
const top = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  verificationToken: { deleteMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: top }));

const EXPIRES = new Date("2030-01-01T00:00:00.000Z");
beforeEach(() => {
  trace.calls.length = 0; trace.lockSql = ""; trace.lockValues = []; trace.lockRows = [{ "?column?": 1 }];
  tx.$queryRaw.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => { trace.calls.push("lock"); trace.lockSql = strings.join("?"); trace.lockValues = values; return trace.lockRows; });
  tx.verificationToken.deleteMany.mockReset().mockImplementation(async () => { trace.calls.push("delete"); return { count: 1 }; });
  tx.verificationToken.create.mockReset().mockImplementation(async (a: { data: unknown }) => { trace.calls.push("create"); return a.data; });
  top.$transaction.mockReset().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  top.$queryRaw.mockReset().mockImplementation(fail("prisma.$queryRaw"));
  top.verificationToken.deleteMany.mockReset().mockImplementation(fail("prisma.verificationToken.deleteMany"));
  top.verificationToken.create.mockReset().mockImplementation(fail("prisma.verificationToken.create"));
  top.verificationToken.findFirst.mockReset();
});

describe("replace", () => {
  it("una transacción interactiva: bloquea la fila del usuario, borra los tokens de esa cuenta y finalidad y crea el nuevo, en ese orden", async () => {
    const row = await tokenRepository.replace("ana@example.com", "RESET_PASSWORD", "h".repeat(64), EXPIRES);
    expect(top.$transaction).toHaveBeenCalledTimes(1);
    expect(trace.calls).toEqual(["lock", "delete", "create"]);
    expect(tx.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { identifier: "ana@example.com", kind: "RESET_PASSWORD" } });
    expect(tx.verificationToken.create).toHaveBeenCalledWith({ data: { identifier: "ana@example.com", kind: "RESET_PASSWORD", token: "h".repeat(64), expires: EXPIRES } });
    expect(row).toEqual({ identifier: "ana@example.com", kind: "RESET_PASSWORD", token: "h".repeat(64), expires: EXPIRES });
  });

  it("el bloqueo es SELECT … FROM \"User\" WHERE \"email\" = <identifier> FOR NO KEY UPDATE, con el identificador como PARÁMETRO (no interpolado)", async () => {
    await tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", "h".repeat(64), EXPIRES);
    expect(trace.lockSql.replace(/\s+/g, " ")).toBe('SELECT 1 FROM "User" WHERE "email" = ? FOR NO KEY UPDATE');
    expect(trace.lockValues).toEqual(["ana@example.com"]);
  });

  it("dentro de la transacción solo se usa `tx`: ninguna operación llega al cliente global", async () => {
    await expect(tokenRepository.replace("ana@example.com", "VERIFY_EMAIL", "h".repeat(64), EXPIRES)).resolves.toBeTruthy();
    expect(top.$queryRaw).not.toHaveBeenCalled();
    expect(top.verificationToken.deleteMany).not.toHaveBeenCalled();
    expect(top.verificationToken.create).not.toHaveBeenCalled();
  });

  it("si la cuenta ya no existe: error propio, sin borrar ni crear nada (no deja un token huérfano)", async () => {
    trace.lockRows = [];
    await expect(tokenRepository.replace("fantasma@example.com", "RESET_PASSWORD", "h".repeat(64), EXPIRES)).rejects.toBeInstanceOf(TokenOwnerMissingError);
    expect(trace.calls).toEqual(["lock"]);
    expect(tx.verificationToken.deleteMany).not.toHaveBeenCalled();
    expect(tx.verificationToken.create).not.toHaveBeenCalled();
  });

  it("el mensaje del error de cuenta inexistente no contiene el identificador", async () => {
    trace.lockRows = [];
    const err = await tokenRepository.replace("fantasma@example.com", "RESET_PASSWORD", "h".repeat(64), EXPIRES).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("fantasma");
    expect((err as Error).name).toBe("TokenOwnerMissingError");
  });

  it("los errores de base de datos se propagan tal cual (no se convierten en éxito): del bloqueo, del borrado y de la creación", async () => {
    const boom = Object.assign(new Error("db"), { code: "P2024" });
    tx.$queryRaw.mockRejectedValueOnce(boom);
    await expect(tokenRepository.replace("a@x.co", "VERIFY_EMAIL", "h".repeat(64), EXPIRES)).rejects.toBe(boom);
    tx.verificationToken.deleteMany.mockRejectedValueOnce(boom);
    await expect(tokenRepository.replace("a@x.co", "VERIFY_EMAIL", "h".repeat(64), EXPIRES)).rejects.toBe(boom);
    tx.verificationToken.create.mockRejectedValueOnce(boom);
    await expect(tokenRepository.replace("a@x.co", "VERIFY_EMAIL", "h".repeat(64), EXPIRES)).rejects.toBe(boom);
  });
});

describe("consume", () => {
  const NOW = new Date("2030-06-01T00:00:00.000Z");
  it("sin fila para ese hash y finalidad: null, y no intenta borrar nada", async () => {
    top.verificationToken.findFirst.mockResolvedValue(null);
    expect(await tokenRepository.consume("h".repeat(64), "VERIFY_EMAIL", NOW)).toBeNull();
    expect(top.verificationToken.findFirst).toHaveBeenCalledWith({ where: { token: "h".repeat(64), kind: "VERIFY_EMAIL" } });
    expect(top.verificationToken.deleteMany).not.toHaveBeenCalled();
  });

  it("el borrado se condiciona por hash, finalidad y caducidad futura; con exactamente una fila borrada devuelve el identificador", async () => {
    top.verificationToken.findFirst.mockResolvedValue({ identifier: "ana@example.com", token: "h", kind: "RESET_PASSWORD", expires: EXPIRES });
    top.verificationToken.deleteMany.mockResolvedValue({ count: 1 });
    expect(await tokenRepository.consume("h".repeat(64), "RESET_PASSWORD", NOW)).toBe("ana@example.com");
    expect(top.verificationToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(top.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { token: "h".repeat(64), kind: "RESET_PASSWORD", expires: { gt: NOW } } });
  });

  it.each([[0], [2], [5]])("si el borrado afecta a %i filas (no exactamente una): null — el perdedor de una carrera no consume", async (count) => {
    top.verificationToken.findFirst.mockResolvedValue({ identifier: "ana@example.com", token: "h", kind: "VERIFY_EMAIL", expires: EXPIRES });
    top.verificationToken.deleteMany.mockResolvedValue({ count });
    expect(await tokenRepository.consume("h".repeat(64), "VERIFY_EMAIL", NOW)).toBeNull();
  });

  it("por defecto usa la hora actual", async () => {
    top.verificationToken.findFirst.mockResolvedValue({ identifier: "a", token: "h", kind: "VERIFY_EMAIL", expires: EXPIRES });
    top.verificationToken.deleteMany.mockResolvedValue({ count: 1 });
    const before = Date.now();
    await tokenRepository.consume("h".repeat(64), "VERIFY_EMAIL");
    const gt = (top.verificationToken.deleteMany.mock.calls[0]![0] as { where: { expires: { gt: Date } } }).where.expires.gt;
    expect(gt.getTime()).toBeGreaterThanOrEqual(before);
    expect(gt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("los errores de base de datos se propagan (no se convierten en «token inválido»)", async () => {
    const boom = Object.assign(new Error("db"), { code: "P1001" });
    top.verificationToken.findFirst.mockRejectedValueOnce(boom);
    await expect(tokenRepository.consume("h", "VERIFY_EMAIL", NOW)).rejects.toBe(boom);
    top.verificationToken.findFirst.mockResolvedValue({ identifier: "a", token: "h", kind: "VERIFY_EMAIL", expires: EXPIRES });
    top.verificationToken.deleteMany.mockRejectedValueOnce(boom);
    await expect(tokenRepository.consume("h", "VERIFY_EMAIL", NOW)).rejects.toBe(boom);
  });
});

describe("delete (limpieza por hash exacto, F.2/F.3): sin cambios", () => {
  it("borra por el hash exacto, sin condiciones adicionales", async () => {
    top.verificationToken.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    await tokenRepository.delete("h".repeat(64));
    expect(top.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { token: "h".repeat(64) } });
  });
});
