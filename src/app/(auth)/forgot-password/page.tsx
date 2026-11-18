import { AuthShell } from "@/features/authentication/components/auth-shell";
import { ForgotForm } from "@/features/authentication/components/token-forms";

export const metadata = { title: "Recuperar contraseña" };

export default function ForgotPage() {
  return (
    <AuthShell title="Recupera tu acceso" subtitle="Te enviaremos un enlace para crear una contraseña nueva.">
      <ForgotForm />
    </AuthShell>
  );
}
