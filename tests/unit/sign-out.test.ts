import { describe, expect, it, vi } from "vitest";
import { runLogout } from "@/features/authentication/components/sign-out-button";

/** Lógica del botón de logout (sin DOM): orden de los pasos y comportamiento ante fallos. */
describe("runLogout", () => {
  it("revoca primero y después borra la cookie", async () => {
    const calls: string[] = [];
    const navigate = vi.fn();
    const result = await runLogout({
      revoke: async () => { calls.push("revoke"); },
      clearCookie: async () => { calls.push("clearCookie"); },
      navigate,
    });
    expect(result).toBe("signed_out");
    expect(calls).toEqual(["revoke", "clearCookie"]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("si falla la revocación en Neon, no borra la cookie ni navega (el logout no se completa)", async () => {
    const clearCookie = vi.fn();
    const navigate = vi.fn();
    const result = await runLogout({ revoke: () => Promise.reject(new Error("500")), clearCookie, navigate });
    expect(result).toBe("revoke_failed");
    expect(clearCookie).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("si la revocación funciona pero falla signOut, navega a /login con carga completa (no queda bloqueado)", async () => {
    const navigate = vi.fn();
    const result = await runLogout({ revoke: async () => undefined, clearCookie: () => Promise.reject(new Error("red")), navigate });
    expect(result).toBe("redirected");
    expect(navigate).toHaveBeenCalledWith("/login");
  });
});
