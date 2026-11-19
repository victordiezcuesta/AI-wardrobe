"use client";
import { useState } from "react";
import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { useToast } from "@/components/ui";
import { api } from "@/utils/api";

export type LogoutResult = "revoke_failed" | "signed_out" | "redirected";

/**
 * Logout en dos pasos (lógica pura, probada en tests/unit/sign-out.test.ts):
 * 1) revocar en Neon la sesión de este dispositivo; si falla, el logout NO se completa;
 * 2) borrar la cookie con Auth.js; si esto falla, la sesión ya está revocada (la cookie ya no da acceso), así que se
 *    navega a /login con una carga completa del navegador.
 */
export async function runLogout(deps: {
  revoke: () => Promise<unknown>;
  clearCookie: () => Promise<unknown>;
  navigate: (url: string) => void;
}): Promise<LogoutResult> {
  try {
    await deps.revoke();
  } catch {
    return "revoke_failed";
  }
  try {
    await deps.clearCookie();
    return "signed_out";
  } catch {
    deps.navigate("/login");
    return "redirected";
  }
}

export function SignOutButton() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    const result = await runLogout({
      revoke: () => api("/api/auth/logout", { method: "POST" }),
      clearCookie: () => signOut({ callbackUrl: "/login" }),
      navigate: (url) => window.location.assign(url),
    });
    if (result === "revoke_failed") toast.error("No se ha podido cerrar la sesión de forma segura. Inténtalo de nuevo.");
    if (result !== "signed_out") setBusy(false); // nunca queda bloqueado en «Cerrando sesión…»
  }

  return (
    <button type="button" onClick={() => void logout()} disabled={busy} aria-busy={busy}
      className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-taupe transition-colors hover:bg-sand hover:text-ink disabled:opacity-60">
      <LogOut className="size-5" aria-hidden />{busy ? "Cerrando sesión…" : "Cerrar sesión"}
    </button>
  );
}
