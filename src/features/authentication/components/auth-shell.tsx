import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden bg-sand lg:flex lg:flex-col lg:justify-between lg:p-14">
        <Link href="/" className="font-display text-3xl">AI Wardrobe</Link>
        <p className="max-w-md font-display text-6xl leading-[1.02]">Tu armario, mirado por alguien con criterio.</p>
        <p className="max-w-sm text-taupe">Fotografía tus prendas, dinos adónde vas y te proponemos qué ponerte con lo que ya tienes.</p>
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-10 block font-display text-3xl lg:hidden">AI Wardrobe</Link>
          <h1 className="font-display text-5xl leading-none">{title}</h1>
          {subtitle && <p className="mt-3 text-taupe">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-taupe">{footer}</div>}
        </div>
      </section>
    </main>
  );
}
