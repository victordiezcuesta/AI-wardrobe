"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Input } from "@/components/ui";
import { api, ApiError } from "@/utils/api";

export function ForgotForm() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try { await api("/api/auth/forgot-password", { method: "POST", json: { email: fd.get("email") } }); setDone(true); }
    catch { setDone(false); } finally { setLoading(false); }
  }
  if (done) return <p className="rounded-card bg-linen p-5">Si la cuenta existe, te hemos enviado un enlace para crear una contraseña nueva.</p>;
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      <Button type="submit" size="lg" className="w-full" loading={loading}>Enviar enlace</Button>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    const fd = new FormData(e.currentTarget);
    try { await api("/api/auth/reset-password", { method: "POST", json: { token, password: fd.get("password") } }); setDone(true); }
    catch (err) { setError(err instanceof ApiError ? (err.issues?.[0]?.message ?? err.message) : "Error inesperado"); }
    finally { setLoading(false); }
  }
  if (done) return <p className="rounded-card bg-linen p-5">Contraseña actualizada. <Link href="/login" className="underline">Inicia sesión</Link>.</p>;
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Nueva contraseña" name="password" type="password" autoComplete="new-password" required error={error} hint="Mínimo 10 caracteres, con mayúscula, minúscula y número." />
      <Button type="submit" size="lg" className="w-full" loading={loading}>Guardar contraseña</Button>
    </form>
  );
}

export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return; // evita doble consumo del token en StrictMode
    sent.current = true;
    api("/api/auth/verify-email", { method: "POST", json: { token } }).then(() => setState("ok")).catch(() => setState("error"));
  }, [token]);
  if (state === "loading") return <p className="text-taupe">Confirmando tu email…</p>;
  if (state === "error") return <p className="rounded-card bg-linen p-5">El enlace no es válido o ha caducado. Vuelve a registrarte o solicita uno nuevo.</p>;
  return <p className="rounded-card bg-linen p-5">Email confirmado. <Link href="/login" className="underline">Inicia sesión</Link>.</p>;
}
