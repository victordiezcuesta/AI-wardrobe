"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, ApiError, NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { groupIssues } from "@/utils/issues";
import { focusFirstError } from "@/features/authentication/focus-error";
import { FormAlert } from "./form-alert";

const FIELDS = ["name", "email", "password"] as const;

export function RegisterForm() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]); // errores sin campo, de servidor o de red (no son de validación de un campo)
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusPending = useRef(false);
  const inFlight = useRef(false);

  // Tras un fallo: primer campo inválido y, si no lo hay, el aviso general. Se hace tras pintar, con el botón ya habilitado.
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    focusFirstError(formRef.current, alertRef.current);
  }, [errors, formErrors]);
  // Al confirmarse el registro el formulario se desmonta: el foco pasa al mensaje (si no, caería en `body`).
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setErrors({});
    setFormErrors([]);
    const fd = new FormData(e.currentTarget);
    try {
      await api("/api/auth/register", { method: "POST", json: { name: String(fd.get("name") || "") || undefined, email: fd.get("email"), password: fd.get("password") } });
      setDone(true);
    } catch (err) {
      focusPending.current = true;
      if (err instanceof ApiError && err.status === 422 && err.issues?.length) {
        // Los errores de campo van a su campo. Los globales (path vacío) y los de un path que el formulario no representa se muestran
        // como errores generales (sin atribuirlos a ningún campo), sin repetir un mensaje que aparezca en ambos grupos.
        const g = groupIssues(err.issues, { fields: FIELDS });
        const general = [...new Set([...g.global, ...g.unmatched.map((u) => u.message)])];
        setErrors(g.fields);
        setFormErrors(general.length > 0 || Object.keys(g.fields).length > 0 ? general : [err.message]);
      } else {
        setFormErrors([err instanceof ApiError ? err.message : NETWORK_ERROR_MESSAGE]);
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  if (done) return <p ref={doneRef} tabIndex={-1} className="rounded-card bg-linen p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Revisa tu correo: si la dirección es válida, te hemos enviado un enlace para confirmar tu cuenta.</p>;

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Nombre (opcional)" name="name" autoComplete="given-name" error={errors.name} />
      <Input label="Email" name="email" type="email" autoComplete="email" required error={errors.email} />
      <Input label="Contraseña" name="password" type="password" autoComplete="new-password" required hint="Mínimo 10 caracteres, con mayúscula, minúscula y número. Máximo 72 bytes UTF-8." error={errors.password} />
      <FormAlert ref={alertRef} messages={formErrors} />
      <Button type="submit" size="lg" className="w-full" loading={loading}>Crear cuenta</Button>
    </form>
  );
}
