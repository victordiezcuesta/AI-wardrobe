import { AuthShell } from "@/features/authentication/components/auth-shell";
import { VerifyEmail } from "@/features/authentication/components/token-forms";

export const metadata = { title: "Confirmar email" };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthShell title="Confirmar email">
      {token ? <VerifyEmail token={token} /> : <p className="rounded-card bg-linen p-5">Falta el enlace de confirmación.</p>}
    </AuthShell>
  );
}
