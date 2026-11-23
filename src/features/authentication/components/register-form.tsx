"use client";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, ApiError } from "@/utils/api";

export function RegisterForm() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setErrors({});
    const fd = new FormData(e.currentTarget);
    try {
      await api("/api/auth/register", { method: "POST", json: { name: String(fd.get("name") || "") || undefined, email: fd.get("email"), password: fd.get("password") } });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.issues) setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      else setErrors({ form: err instanceof Error ? err.message : "Error inesperado" });
    } finally {
      setLoading(false);
    }
  }

  if (done) return <p className="rounded-card bg-linen p-5">Revisa tu correo: si la dirección es válida, te hemos enviado un enlace para confirmar tu cuenta.</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Nombre (opcional)" name="name" autoComplete="given-name" error={errors.name} />
      <Input label="Email" name="email" type="email" autoComplete="email" required error={errors.email} />
      <Input label="Contraseña" name="password" type="password" autoComplete="new-password" required hint="Mínimo 10 caracteres, con mayúscula, minúscula y número. Máximo 72 bytes UTF-8." error={errors.password} />
      {errors.form && <p className="text-sm text-danger">{errors.form}</p>}
      <Button type="submit" size="lg" className="w-full" loading={loading}>Crear cuenta</Button>
    </form>
  );
}
