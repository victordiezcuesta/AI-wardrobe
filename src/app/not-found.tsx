import type { Metadata } from "next";
import Link from "next/link";
import { MAIN_CONTENT_ID } from "@/components/layout/main-content";

/**
 * Fase G (M5) — página 404 propia. `app/not-found.tsx` en la raíz es la convención nativa de Next: la usa tanto `notFound()` como
 * cualquier URL sin ruta (Next la compila como `/_not-found`, dentro del layout raíz, con estado 404 y `noindex`). Sustituye a la
 * página por defecto de Next (en inglés, sin marca, sin enlace de vuelta y sin <main>).
 *
 * Es un Server Component sin datos ni sesión: no necesita "use client".
 *
 * Destino «Volver al inicio» = "/": es una ruta pública (`authorized` en lib/auth/config) y `app/page.tsx` redirige a /dashboard con
 * sesión o a /login sin ella, así que resuelve bien ambos casos sin que esta página consulte la sesión. (Sin sesión, el proxy ya
 * redirige las rutas desconocidas a /login: esta página solo la ve quien tiene sesión.)
 */
export const metadata: Metadata = { title: "Página no encontrada" };

export default function NotFound() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-16 text-center focus:outline-none">
      <p className="font-display text-8xl leading-none text-taupe">404</p>
      <h1 className="mt-6 text-balance font-display text-5xl leading-none">No encontramos esa página</h1>
      <p className="mt-4 text-balance text-taupe">Puede que el enlace esté mal escrito o que la página ya no exista.</p>
      <Link href="/" className="mt-8 inline-flex h-11 items-center rounded-full bg-ink px-6 text-[0.95rem] font-medium text-paper hover:bg-taupe">Volver al inicio</Link>
    </main>
  );
}
