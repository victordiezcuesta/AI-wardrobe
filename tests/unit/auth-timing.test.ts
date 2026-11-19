import bcrypt from "bcryptjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Enumeración de usuarios por tiempo en el login: la ruta de «email inexistente» debe hacer el mismo trabajo bcrypt
 * (coste 12) que la de un usuario real. Se comprueba de forma estructural (hash bien formado, coste y que la comparación
 * se ejecuta), no midiendo milisegundos, que serían inestables con la carga del sistema.
 */
const findByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/repositories/user.repository", () => ({ userRepository: { findByEmail } }));

const { authService, DUMMY_PASSWORD_HASH } = await import("@/services/auth.service");

const PASS = "Abcdefghi1";
let realHash: string;
beforeAll(async () => { realHash = await bcrypt.hash(PASS, 12); }, 30_000);
afterEach(() => { vi.restoreAllMocks(); findByEmail.mockReset(); });

const user = (over: Record<string, unknown> = {}) => ({ id: "u1", email: "ana@test.com", name: "Ana", passwordHash: realHash, emailVerified: new Date(), ...over });
const TIMEOUT = 30_000; // cada comparación bcrypt de coste 12 en JS puro cuesta ~0,7 s de CPU

describe("hash ficticio del login", () => {
  it("tiene formato bcrypt válido y 60 caracteres", () => {
    expect(DUMMY_PASSWORD_HASH).toHaveLength(60);
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
  });

  it("usa coste 12, igual que las contraseñas reales", () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(12);
    expect(bcrypt.getRounds(realHash)).toBe(bcrypt.getRounds(DUMMY_PASSWORD_HASH));
  });

  it("no coincide con ninguna contraseña habitual", async () => {
    for (const p of ["", PASS, "password", "invalid"]) expect(await bcrypt.compare(p, DUMMY_PASSWORD_HASH)).toBe(false);
  }, TIMEOUT);
});

describe("verifyCredentials ejecuta siempre la comparación bcrypt", () => {
  it("email inexistente → compara contra el hash ficticio y devuelve null", async () => {
    findByEmail.mockResolvedValue(null);
    const spy = vi.spyOn(bcrypt, "compare");
    expect(await authService.verifyCredentials("nadie@test.com", PASS)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(PASS, DUMMY_PASSWORD_HASH);
  }, TIMEOUT);

  it("usuario sin contraseña (p. ej. OAuth) → también compara contra el hash ficticio", async () => {
    findByEmail.mockResolvedValue(user({ passwordHash: null }));
    const spy = vi.spyOn(bcrypt, "compare");
    expect(await authService.verifyCredentials("ana@test.com", PASS)).toBeNull();
    expect(spy).toHaveBeenCalledWith(PASS, DUMMY_PASSWORD_HASH);
  }, TIMEOUT);

  it("usuario existente con contraseña correcta → devuelve el usuario", async () => {
    findByEmail.mockResolvedValue(user());
    const spy = vi.spyOn(bcrypt, "compare");
    expect(await authService.verifyCredentials("ana@test.com", PASS)).toEqual({ id: "u1", email: "ana@test.com", name: "Ana" });
    expect(spy).toHaveBeenCalledWith(PASS, realHash);
  }, TIMEOUT);

  it("usuario existente con contraseña incorrecta → null, tras comparar con su hash real", async () => {
    findByEmail.mockResolvedValue(user());
    const spy = vi.spyOn(bcrypt, "compare");
    expect(await authService.verifyCredentials("ana@test.com", "otra-Clave123")).toBeNull();
    expect(spy).toHaveBeenCalledWith("otra-Clave123", realHash);
  }, TIMEOUT);

  it("usuario sin verificar con contraseña correcta → null (sin cambios de comportamiento)", async () => {
    findByEmail.mockResolvedValue(user({ emailVerified: null }));
    expect(await authService.verifyCredentials("ana@test.com", PASS)).toBeNull();
  }, TIMEOUT);

  it("las tres respuestas de fallo son idénticas (no revelan si el email existe)", async () => {
    findByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(user()).mockResolvedValueOnce(user({ emailVerified: null }));
    const results = [
      await authService.verifyCredentials("nadie@test.com", PASS),
      await authService.verifyCredentials("ana@test.com", "otra-Clave123"),
      await authService.verifyCredentials("ana@test.com", PASS),
    ];
    expect(results).toEqual([null, null, null]);
  }, TIMEOUT);
});
