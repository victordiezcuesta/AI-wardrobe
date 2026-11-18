import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { userRepository } from "@/repositories/user.repository";
import { ProfileForm } from "@/features/profile/components/profile-form";
import { toFormValues } from "@/features/profile/to-form-values";

export const metadata = { title: "Cuéntanos cómo vistes" };

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await userRepository.findById(session.user.id);
  if (!user) redirect("/login");
  if (user.profile?.onboardingDone) redirect("/dashboard");
  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <h1 className="font-display text-6xl leading-none">Cuéntanos cómo vistes</h1>
      <p className="mt-4 max-w-xl text-taupe">Todo es opcional y podrás cambiarlo desde tu perfil. Cuanto más sepamos, mejores serán los conjuntos.</p>
      <div className="mt-12"><ProfileForm mode="onboarding" initial={toFormValues(user.name, user.profile)} /></div>
    </main>
  );
}
