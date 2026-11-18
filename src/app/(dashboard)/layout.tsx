import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { auth, signOut } from "@/lib/auth";
import { userRepository } from "@/repositories/user.repository";
import { AppNav } from "@/components/layout/app-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await userRepository.findById(session.user.id);
  if (!user) redirect("/login");
  if (!user.profile?.onboardingDone) redirect("/onboarding");

  const signOutSlot = (
    <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
      <button type="submit" className="flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-taupe transition-colors hover:bg-sand hover:text-ink">
        <LogOut className="size-5" aria-hidden />Cerrar sesión
      </button>
    </form>
  );

  return (
    <div className="lg:flex">
      <AppNav signOutSlot={signOutSlot} />
      <main className="min-w-0 flex-1 px-6 pb-28 pt-10 lg:px-14 lg:pb-14">{children}</main>
    </div>
  );
}
