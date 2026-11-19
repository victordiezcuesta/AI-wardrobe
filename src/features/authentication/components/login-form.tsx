"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button, Input } from "@/components/ui";
import { loginErrorMessage } from "@/features/authentication/login-errors";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
    setLoading(false);
    if (message) return setError(message);
    const next = params.get("callbackUrl");
    router.push(next && next.startsWith("/") ? next : "/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Input label="Email" name="email" type="email" autoComplete="email" required />
      <Input label="Contraseña" name="password" type="password" autoComplete="current-password" required error={error} />
      <Button type="submit" size="lg" className="w-full" loading={loading}>Entrar</Button>
    </form>
  );
}
