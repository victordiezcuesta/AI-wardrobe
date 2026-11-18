"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/utils/cn";
import { NAV_ITEMS } from "./nav-items";

export function AppNav({ signOutSlot }: { signOutSlot: React.ReactNode }) {
  const path = usePathname();
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col justify-between bg-linen p-6 lg:flex">
        <div>
          <Link href="/dashboard" className="font-display text-3xl">AI Wardrobe</Link>
          <nav aria-label="Principal" className="mt-10 space-y-1">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}
                className={cn("flex items-center gap-3 rounded-full px-4 py-2.5 transition-colors", path.startsWith(href) ? "bg-ink text-paper" : "hover:bg-sand")}>
                <Icon className="size-5" aria-hidden />{label}
              </Link>
            ))}
          </nav>
        </div>
        {signOutSlot}
      </aside>
      <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-30 flex justify-around bg-paper/95 px-2 pb-[env(safe-area-inset-bottom)] pt-2 shadow-[0_-8px_24px_-16px_rgb(22_21_20/0.25)] backdrop-blur lg:hidden">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}
            className={cn("flex min-w-16 flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-xs", path.startsWith(href) ? "text-ink" : "text-taupe")}>
            <Icon className="size-5" aria-hidden />{label}
          </Link>
        ))}
      </nav>
    </>
  );
}
