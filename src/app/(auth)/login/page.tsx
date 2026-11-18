import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/features/authentication/components/auth-shell";
import { LoginForm } from "@/features/authentication/components/login-form";

export const metadata = { title: "Iniciar sesión" };

export default function LoginPage() {
  return (
    <AuthShell
      title="Bienvenido de nuevo"
      subtitle="Entra para ver tu armario."
      footer={<><Link href="/forgot-password" className="underline">He olvidado mi contraseña</Link><br />¿Sin cuenta? <Link href="/register" className="underline">Crear una</Link></>}
    >
      <Suspense><LoginForm /></Suspense>
    </AuthShell>
  );
}
