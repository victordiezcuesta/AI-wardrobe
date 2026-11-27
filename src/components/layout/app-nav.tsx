"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/utils/cn";
import { NAV_ITEMS } from "./nav-items";

/**
 * `children` (el `<main>`) se pinta ENTRE la barra lateral y la navegación móvil: la barra móvil es `fixed` y se ve abajo, así que va
 * DESPUÉS del contenido en el DOM y el orden de Tab coincide con el visual (antes iba primero y el teclado recorría los seis enlaces
 * antes del contenido). En escritorio no cambia nada: la barra lateral sigue antes del contenido y la móvil está oculta (`lg:hidden`).
 */
export function AppNav({ signOutSlot, children }: { signOutSlot: React.ReactNode; children?: React.ReactNode }) {
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
      {children}
      {/* Rejilla de columnas iguales (una por destino): los seis elementos siempre caben en el ancho disponible (antes, min-w-16 × 6
          = 384 px desbordaba a 375 px y dejaba «Perfil» fuera de la pantalla a 320 px). `min-w-0` permite encoger la celda,
          sin relleno lateral para que «Completa» (la etiqueta más larga, ~48 px a 11 px) tenga holgura incluso a 305 px (320 px con barra de
          desplazamiento clásica), y `min-h-12` (48 px) garantiza un objetivo táctil de al menos 44 px de alto. */}
      <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 bg-paper/95 px-0.5 pb-[env(safe-area-inset-bottom)] pt-2 shadow-[0_-8px_24px_-16px_rgb(22_21_20/0.25)] backdrop-blur lg:hidden">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}
            className={cn("flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0 py-1.5 text-[0.6875rem] leading-tight min-[375px]:text-xs", path.startsWith(href) ? "text-ink" : "text-taupe")}>
            <Icon className="size-5" aria-hidden /><span className="max-w-full truncate">{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
