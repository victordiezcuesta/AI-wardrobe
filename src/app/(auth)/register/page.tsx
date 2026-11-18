import Link from "next/link";
import { AuthShell } from "@/features/authentication/components/auth-shell";
import { RegisterForm } from "@/features/authentication/components/register-form";

export const metadata = { title: "Crear cuenta" };

export default function RegisterPage() {
  return (
    <AuthShell title="Empieza con tu armario" subtitle="Crea tu cuenta en un minuto." footer={<>¿Ya tienes cuenta? <Link href="/login" className="underline">Entrar</Link></>}>
      <RegisterForm />
    </AuthShell>
  );
}
