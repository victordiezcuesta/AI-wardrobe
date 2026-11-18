import { AuthShell } from "@/features/authentication/components/auth-shell";
import { ResetForm } from "@/features/authentication/components/token-forms";

export const metadata = { title: "Nueva contraseña" };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthShell title="Nueva contraseña">
      {token ? <ResetForm token={token} /> : <p className="rounded-card bg-linen p-5">Falta el enlace de recuperación. Solicita uno nuevo.</p>}
    </AuthShell>
  );
}
