import { auth } from "@/lib/auth";
import { userRepository } from "@/repositories/user.repository";
import { ProfileForm } from "@/features/profile/components/profile-form";
import { toFormValues } from "@/features/profile/to-form-values";
import { PrivacyPanel } from "@/features/profile/components/privacy-panel";

export const metadata = { title: "Perfil" };

export default async function ProfilePage() {
  const session = await auth();
  const user = await userRepository.findById(session!.user.id);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-6xl leading-none">Tu perfil</h1>
      <p className="mt-4 text-taupe">Estas preferencias guían a la IA cuando te propone conjuntos.</p>
      <div className="mt-12"><ProfileForm mode="settings" initial={toFormValues(user?.name, user?.profile ?? null)} /></div>
      <div className="mt-16"><PrivacyPanel /></div>
    </div>
  );
}
