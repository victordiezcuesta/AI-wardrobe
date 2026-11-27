"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Input } from "@/components/ui";
import { api, ApiError, NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { groupIssues } from "@/utils/issues";
import { focusFirstError } from "@/features/authentication/focus-error";
import { FormAlert } from "./form-alert";

export function ForgotForm() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusPending = useRef(false);
  const inFlight = useRef(false);

  // Tras un fallo: campo inválido (email) o aviso general, con el botón ya habilitado. Tras el éxito, el mensaje (el formulario desaparece).
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    focusFirstError(formRef.current, alertRef.current);
  }, [errors, formErrors]);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setErrors({});
    setFormErrors([]);
    const fd = new FormData(e.currentTarget);
    try { await api("/api/auth/forgot-password", { method: "POST", json: { email: fd.get("email") } }); setDone(true); }
    catch (err) {
      // Antes se tragaba cualquier error y el usuario no veía nada. El servidor responde igual exista o no la cuenta, así que ningún
      // mensaje de aquí revela si el correo está registrado: solo distingue validación, límite de intentos, servidor y red.
      focusPending.current = true;
      if (err instanceof ApiError && err.status === 422 && err.issues?.length) {
        const g = groupIssues(err.issues, { fields: ["email"] });
        const general = [...new Set([...g.global, ...g.unmatched.map((u) => u.message)])];
        setErrors(g.fields);
        setFormErrors(general.length > 0 || Object.keys(g.fields).length > 0 ? general : [err.message]);
      } else {
        setFormErrors([err instanceof ApiError ? err.message : NETWORK_ERROR_MESSAGE]);
      }
    } finally { inFlight.current = false; setLoading(false); }
  }
  if (done) return <p ref={doneRef} tabIndex={-1} className="rounded-card bg-linen p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Si la cuenta existe, te hemos enviado un enlace para crear una contraseña nueva.</p>;
  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Email" name="email" type="email" autoComplete="email" required error={errors.email} />
      <FormAlert ref={alertRef} messages={formErrors} />
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
      <Input label="Nueva contraseña" name="password" type="password" autoComplete="new-password" required error={error} hint="Mínimo 10 caracteres, con mayúscula, minúscula y número. Máximo 72 bytes UTF-8." />
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
