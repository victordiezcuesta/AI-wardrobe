import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { currentSession } from "@/lib/auth/session";
import { Card } from "@/components/ui";
import { WeatherCard } from "@/features/stylist/components/weather-card";
import { CATEGORY_LABELS, COLOR_SWATCH, type CategoryKey, type ColorKey } from "@/features/wardrobe/constants";
import { dashboardService } from "@/services/dashboard.service";

export const metadata = { title: "Inicio" };

type Outfit = Awaited<ReturnType<typeof dashboardService.get>>["recent"][number];

function Thumbs({ outfit, size = "md" }: { outfit: Outfit; size?: "sm" | "md" }) {
  return (
    <ul className={size === "md" ? "grid grid-cols-4 gap-2" : "flex gap-1.5"}>
      {outfit.items.slice(0, 4).map(({ item }) => (
        <li key={item.id} className={`relative aspect-[4/5] overflow-hidden rounded-xl bg-sand ${size === "sm" ? "w-12" : ""}`}>
          {item.thumbUrl
            ? <Image src={item.thumbUrl} alt={item.name} fill unoptimized sizes="120px" className="object-cover" />
            : <span className="absolute inset-0" style={{ background: COLOR_SWATCH[(item.primaryColor ?? "otro") as ColorKey] ?? COLOR_SWATCH.otro }} />}
        </li>
      ))}
    </ul>
  );
}

export default async function DashboardPage() {
  // Comprobación propia: el layout y la página se renderizan en paralelo, no se puede confiar en su redirección.
  const userId = (await currentSession())?.user?.id;
  if (!userId) redirect("/login");
  const d = await dashboardService.get(userId);
  const first = d.name?.split(" ")[0];
  const w = d.wardrobe;

  return (
    <div className="mx-auto max-w-5xl space-y-12">
      <header>
        <h1 className="font-display text-6xl leading-none">{first ? `Hola, ${first}` : "Hola"}</h1>
        <p className="mt-3 text-taupe">{w.total === 0 ? "Empieza subiendo fotos de tu ropa." : `Tienes ${w.available} ${w.available === 1 ? "prenda disponible" : "prendas disponibles"} para combinar.`}</p>
      </header>

      {d.weather && d.home ? (
        <WeatherCard weather={{ date: d.weather.date, daily: d.weather.daily }} place={`Hoy en ${d.home.name}`} />
      ) : (
        <p className="text-sm text-taupe">{d.home ? "No hemos podido consultar el clima ahora mismo." : <>Añade tu ciudad en tu <Link href="/profile" className="underline">perfil</Link> para ver aquí el clima de hoy.</>}</p>
      )}

      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]" aria-label="Recomendación del día">
        <Card className="space-y-4">
          <h2 className="font-display text-3xl">Recomendación del día</h2>
          {d.today ? (
            <>
              <Thumbs outfit={d.today} />
              <div>
                <p className="font-medium">{d.today.name}</p>
                <p className="mt-1 text-sm text-taupe">{d.today.description}</p>
              </div>
              <Link href="/stylist" className="inline-flex items-center gap-1.5 text-sm underline">Ver todos mis conjuntos<ArrowRight className="size-3.5" aria-hidden /></Link>
            </>
          ) : (
            <>
              <p className="text-taupe">Todavía no has pedido un conjunto para hoy. El estilista tiene en cuenta el clima y tu plan, y solo usa prendas que tienes.</p>
              <Link href="/stylist" className="inline-flex h-11 items-center rounded-full bg-ink px-6 text-[0.95rem] font-medium text-paper hover:bg-taupe">Pedir un conjunto para hoy</Link>
            </>
          )}
        </Card>

        <Card className="space-y-4">
          <h2 className="font-display text-3xl">Tu armario</h2>
          <p className="font-display text-5xl leading-none">{w.total}</p>
          <ul className="space-y-1 text-sm text-taupe">
            {w.topCategories.map((c) => <li key={c.category}>{CATEGORY_LABELS[c.category as CategoryKey]}: {c.count}</li>)}
            {w.dirty > 0 && <li>Sucias: {w.dirty}</li>}
            {w.unavailable > 0 && <li>No disponibles: {w.unavailable}</li>}
          </ul>
          {w.needsReview > 0 && <Link href="/wardrobe" className="block text-sm underline">{w.needsReview} {w.needsReview === 1 ? "prenda por revisar" : "prendas por revisar"}</Link>}
          <Link href="/wardrobe" className="inline-flex items-center gap-1.5 text-sm underline">Abrir mi armario<ArrowRight className="size-3.5" aria-hidden /></Link>
        </Card>
      </section>

      {d.recent.length > 0 && (
        <section aria-label="Conjuntos recientes" className="space-y-4">
          <h2 className="font-display text-4xl leading-none">Conjuntos recientes</h2>
          <ul className="grid gap-4 sm:grid-cols-3">
            {d.recent.map((o) => (
              <li key={o.id}><Link href="/stylist" className="block space-y-2 rounded-card bg-linen p-4 transition-colors hover:bg-sand"><Thumbs outfit={o} size="sm" /><p className="truncate text-sm font-medium">{o.name}</p></Link></li>
            ))}
          </ul>
        </section>
      )}

      {d.gaps.length > 0 && (
        <section aria-label="Sugerencias de compra" className="space-y-4">
          <h2 className="font-display text-4xl leading-none">Lo que te falta</h2>
          <ul className="flex flex-wrap gap-2">
            {d.gaps.map((g) => <li key={g.label} className="rounded-full bg-linen px-4 py-1.5 text-sm">{g.label}</li>)}
          </ul>
          <Link href="/shopping" className="inline-flex items-center gap-1.5 text-sm underline">Ver productos para completar tu armario<ArrowRight className="size-3.5" aria-hidden /></Link>
        </section>
      )}
    </div>
  );
}
