import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth/session";
import { userRepository } from "@/repositories/user.repository";
import { AppNav } from "@/components/layout/app-nav";
import { SignOutButton } from "@/features/authentication/components/sign-out-button";
import { MAIN_CONTENT_ID } from "@/components/layout/main-content";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session?.user?.id) redirect("/login");
  const user = await userRepository.findById(session.user.id);
  if (!user) redirect("/login");
  if (!user.profile?.onboardingDone) redirect("/onboarding");

  return (
    <div className="lg:flex">
      <AppNav signOutSlot={<SignOutButton />}>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 px-6 pb-28 pt-10 focus:outline-none lg:px-14 lg:pb-14">{children}</main>
      </AppNav>
    </div>
  );
}
