"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw, Sparkles, Store } from "lucide-react";
import { Button, Select, Skeleton, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";

interface Mini { id: string; name: string; thumbUrl: string | null }
interface Product { id: string; name: string; brand: string | null; store: string; priceCents: number; currency: string; color: string | null; imageUrl: string | null; url: string; matchReason: string | null; score: number | null; combinesWith: Mini[] }
interface Gap { id: string; label: string; reason: string; category: string | null; color: string | null; aiRanked: boolean; status: "found" | "unavailable"; combinesWith: Mini[]; products: Product[] }
interface Batch { batchId: string; createdAt: string; fromCache: boolean; gaps: Gap[] }
interface Status { configured: boolean; products: number; stores: { store: string; count: number }[]; lastSyncAt: string | null }

const eur = (c: number, cur = "EUR") => new Intl.NumberFormat("es-ES", { style: "currency", currency: cur }).format(c / 100);
const when = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long" });

function Badge({ kind }: { kind: "ai" | "found" | "unavailable" }) {
  const map = { ai: ["Sugerencia de la IA", "bg-sand"], found: ["Producto encontrado", "bg-ink text-paper"], unavailable: ["No disponible", "bg-paper ring-1 ring-stone"] } as const;
  return <span className={cn("rounded-full px-3 py-1 text-xs font-medium", map[kind][1])}>{map[kind][0]}</span>;
}

export function ShoppingView() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [store, setStore] = useState("");
  const [brand, setBrand] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<Status>("/api/shopping/status"), api<{ batch: Batch | null }>("/api/shopping/recommend")])
      .then(([s, b]) => { if (!cancelled) { setStatus(s); setBatch(b.batch); setLoading(false); } })
      .catch((e) => { if (!cancelled) { toast.error(e instanceof Error ? e.message : "No se pudo cargar"); setLoading(false); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(force: boolean) {
    setRunning(true);
    try { setBatch((await api<{ batch: Batch }>("/api/shopping/recommend", { method: "POST", json: { force } })).batch); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo analizar tu armario"); }
    finally { setRunning(false); }
  }

  const all = useMemo(() => batch?.gaps.flatMap((g) => g.products) ?? [], [batch]);
  const stores = useMemo(() => [...new Set(all.map((p) => p.store))].sort(), [all]);
  const brands = useMemo(() => [...new Set(all.map((p) => p.brand).filter((b): b is string => !!b))].sort(), [all]);
  const max = maxPrice ? Math.round(Number(maxPrice) * 100) : null;
  const visible = (g: Gap) => g.products.filter((p) => (!store || p.store === store) && (!brand || p.brand === brand) && (max == null || p.priceCents <= max));

  if (loading) return <div className="space-y-6"><Skeleton className="h-16 w-80" /><Skeleton className="h-72" /></div>;
  const noCatalog = !status || status.products === 0;

  return (
    <div className="space-y-12">
      <section>
        <h1 className="font-display text-6xl leading-none">Completa tu armario</h1>
        <p className="mt-4 max-w-xl text-taupe">Detectamos qué prendas te faltan para combinar mejor lo que ya tienes y buscamos opciones reales en tiendas de España.</p>

        {noCatalog && (
          <div className="mt-8 max-w-2xl rounded-card bg-linen p-6">
            <p className="flex items-center gap-2 font-medium"><Store className="size-4" aria-hidden />{status?.configured ? "El catálogo de tiendas aún no se ha cargado" : "No hay tiendas conectadas todavía"}</p>
            <p className="mt-2 text-sm text-taupe">
              {status?.configured
                ? "La conexión está configurada pero todavía no se ha completado una sincronización. Puedes seguir viendo qué prendas te faltan; los productos aparecerán cuando termine."
                : "Podrás ver qué prendas te faltan, pero no habrá productos reales hasta que se conecte una fuente de catálogo autorizada (por ejemplo, feeds de afiliación). Nunca mostramos productos inventados."}
            </p>
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={() => void run(false)} loading={running}><Sparkles className="size-4" aria-hidden />{batch ? "Ver recomendaciones" : "Analizar mi armario"}</Button>
          {batch && <Button variant="ghost" size="lg" onClick={() => void run(true)} disabled={running}><RefreshCw className="size-4" aria-hidden />Volver a analizar</Button>}
        </div>
        {batch?.fromCache && <p className="mt-3 text-sm text-taupe">Mostrando el análisis del {when(batch.createdAt)}: tu armario no ha cambiado desde entonces.</p>}
      </section>

      {running && <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div>}

      {!running && batch && (
        <>
          {all.length > 0 && (
            <section aria-label="Filtros" className="grid max-w-3xl gap-4 sm:grid-cols-3">
              <Select label="Tienda" value={store} onChange={(e) => setStore(e.target.value)}><option value="">Todas</option>{stores.map((s) => <option key={s}>{s}</option>)}</Select>
              <Select label="Marca" value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">Todas</option>{brands.map((b) => <option key={b}>{b}</option>)}</Select>
              <div className="space-y-1.5">
                <label htmlFor="maxp" className="block text-sm font-medium">Precio máximo (€)</label>
                <input id="maxp" type="number" inputMode="numeric" min={0} value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className="h-11 w-full rounded-field border border-stone/70 bg-paper px-4 text-[0.95rem] focus:border-ink focus:outline-none" />
              </div>
            </section>
          )}

          <div className="space-y-12">
            {batch.gaps.map((g) => {
              const shown = visible(g);
              return (
                <section key={g.id} className="space-y-5" aria-labelledby={`gap-${g.id}`}>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2"><Badge kind="ai" /><Badge kind={g.status} /></div>
                    <h2 id={`gap-${g.id}`} className="font-display text-4xl leading-tight">{g.label}</h2>
                    <p className="max-w-2xl text-taupe">{g.reason}</p>
                    {g.combinesWith.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
                        <span className="text-taupe">Combina con:</span>
                        {g.combinesWith.map((m) => (
                          <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full bg-linen py-1 pl-1 pr-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {m.thumbUrl ? <img src={m.thumbUrl} alt="" className="size-6 rounded-full object-cover" /> : <span className="size-6 rounded-full bg-sand" />}{m.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {g.status === "unavailable" ? (
                    <p className="rounded-card bg-linen p-5 text-sm">No hemos encontrado productos disponibles para esto en las tiendas conectadas{noCatalog ? " (el catálogo aún está vacío)" : ""}. Es una sugerencia de la IA: puedes buscarla tú mismo en tu tienda favorita.</p>
                  ) : shown.length === 0 ? (
                    <p className="text-sm text-taupe">Ningún producto cumple los filtros actuales.</p>
                  ) : (
                    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
                      {shown.map((p) => (
                        <li key={p.id} className="flex flex-col">
                          <a href={p.url} target="_blank" rel="noopener noreferrer sponsored" className="group block">
                            <div className="relative aspect-[4/5] overflow-hidden rounded-card bg-sand">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {p.imageUrl && <img src={p.imageUrl} alt={p.name} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />}
                              <span className="absolute left-3 top-3"><Badge kind="found" /></span>
                            </div>
                            <p className="mt-2 line-clamp-2 text-sm font-medium">{p.name}</p>
                          </a>
                          <p className="text-sm text-taupe">{p.brand ? `${p.brand} · ` : ""}{p.store}{p.color ? ` · ${p.color}` : ""}</p>
                          <p className="mt-0.5 font-medium">{eur(p.priceCents, p.currency)}</p>
                          {p.matchReason && <p className="mt-1.5 text-xs text-taupe">{p.matchReason}</p>}
                          {p.combinesWith.length > 0 && <p className="mt-1 text-xs text-taupe">Combina con: {p.combinesWith.map((m) => m.name).join(", ")}</p>}
                          <a href={p.url} target="_blank" rel="noopener noreferrer sponsored" className="mt-2 inline-flex items-center gap-1.5 text-sm underline">Ver en {p.store}<ExternalLink className="size-3.5" aria-hidden /></a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {g.status === "found" && !g.aiRanked && <p className="text-xs text-taupe">Ordenado por coincidencia de color, marca y presupuesto (la IA no estuvo disponible para ordenarlo).</p>}
                </section>
              );
            })}
          </div>

          {all.length > 0 && (
            <aside className="max-w-2xl space-y-1.5 rounded-card bg-linen p-5 text-xs text-taupe">
              <p><strong className="text-ink">Enlaces de afiliación.</strong> Si compras a través de estos enlaces, AI Wardrobe puede recibir una comisión, sin coste adicional para ti.</p>
              <p>Precios y disponibilidad según la última sincronización{status?.lastSyncAt ? ` (${when(status.lastSyncAt)})` : ""}; pueden haber cambiado. Confirma siempre en la tienda.</p>
            </aside>
          )}
        </>
      )}

      {!batch && !running && <p className="text-taupe">¿Aún no tienes prendas? <Link href="/wardrobe" className="underline">Añádelas a tu armario</Link> y vuelve.</p>}
    </div>
  );
}
