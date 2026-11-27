"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button, Input } from "@/components/ui";
import { loginErrorMessage } from "@/features/authentication/login-errors";
import { safeCallbackPath } from "@/features/authentication/callback-url";
import { focusFirstError } from "@/features/authentication/focus-error";
import { FormAlert } from "./form-alert";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const inFlight = useRef(false);

  // Tras un fallo el botón vuelve a estar habilitado y el aviso ya está pintado: el foco va al aviso general (no hay errores de campo),
  // en lugar de quedarse en el botón que se deshabilitó durante la carga (el navegador lo deja en `body`).
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    focusFirstError(formRef.current, alertRef.current);
  }, [error]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(undefined);
    const fd = new FormData(e.currentTarget);
    let message: string | null;
    try {
      const res = await signIn("credentials", { email: String(fd.get("email")), password: String(fd.get("password")), redirect: false });
      message = loginErrorMessage(res);
    } catch {
      message = loginErrorMessage(null); // red caída o respuesta ilegible: error temporal, no de credenciales
    }
    inFlight.current = false;
    setLoading(false);
    if (message) { focusPending.current = true; return setError(message); }
    // callbackUrl viene de la URL (no confiable): solo se sigue si es una ruta interna del mismo origen.
    router.push(safeCallbackPath(params.get("callbackUrl"), window.location.origin));
    router.refresh();
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      <Input label="Contraseña" name="password" type="password" autoComplete="current-password" required />
      {/* El error de acceso no es de un campo (el mensaje es genérico a propósito): va en el aviso general, no en la contraseña. */}
      <FormAlert ref={alertRef} messages={error ? [error] : []} />
      <Button type="submit" size="lg" className="w-full" loading={loading}>Entrar</Button>
    </form>
  );
}
