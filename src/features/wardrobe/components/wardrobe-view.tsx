"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button, Select, Skeleton, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";
import { CATEGORIES, CATEGORY_LABELS, COLORS, SEASONS, SEASON_LABELS, STATUSES, STATUS_LABELS } from "../constants";
import type { ItemDTO } from "../types";
import { ItemCard } from "./item-card";
import { ItemEditor } from "./item-editor";
import { AddItems } from "./add-items";

interface Filters { q: string; category: string; color: string; season: string; status: string; favorite: boolean; needsReview: boolean }
const EMPTY: Filters = { q: "", category: "", color: "", season: "", status: "", favorite: false, needsReview: false };

function toQuery(f: Filters, cursor?: string) {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const k of ["category", "color", "season", "status"] as const) if (f[k]) p.set(k, f[k]);
  if (f.favorite) p.set("favorite", "true");
  if (f.needsReview) p.set("needsReview", "true");
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export function WardrobeView() {
  const toast = useToast();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<ItemDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState<ItemDTO | null>(null);
  const [adding, setAdding] = useState(false);
  const reqId = useRef(0);
  const [touched, setTouched] = useState(false);   // el recuento se anuncia solo tras una acción del usuario sobre la búsqueda o los filtros

  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await api<{ items: ItemDTO[]; nextCursor: string | null }>(`/api/wardrobe?${toQuery(f)}`);
      if (id !== reqId.current) return; // respuesta obsoleta
      setItems(res.items);
      setCursor(res.nextCursor);
    } catch (e) {
      if (id === reqId.current) toast.error(e instanceof Error ? e.message : "No se pudo cargar el armario");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(filters), filters.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [filters, load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api<{ items: ItemDTO[]; nextCursor: string | null }>(`/api/wardrobe?${toQuery(filters, cursor)}`);
      setItems((s) => [...s, ...res.items]);
      setCursor(res.nextCursor);
    } finally { setLoadingMore(false); }
  }

  async function toggleFavorite(item: ItemDTO) {
    const next = !item.isFavorite;
    setItems((s) => s.map((i) => (i.id === item.id ? { ...i, isFavorite: next } : i)));
    try { await api(`/api/wardrobe/${item.id}`, { method: "PATCH", json: { isFavorite: next } }); }
    catch (e) {
      setItems((s) => s.map((i) => (i.id === item.id ? { ...i, isFavorite: !next } : i)));
      toast.error(e instanceof Error ? e.message : "No se pudo actualizar");
    }
  }

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => { setTouched(true); setFilters((s) => ({ ...s, [k]: v })); };
  const active = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-6xl leading-none">Mi armario</h1>
        <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />Añadir prendas</Button>
      </div>

      <div className="mt-8 space-y-4">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-taupe" aria-hidden />
          <input type="search" aria-label="Buscar por nombre" placeholder="Buscar por nombre" value={filters.q} onChange={(e) => set("q", e.target.value)}
            className="h-11 w-full rounded-full border border-control bg-paper pl-11 pr-4 text-[0.95rem] placeholder:text-taupe focus:border-ink focus:outline-none" />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Categorías">
          {[["", "Todo"], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as const)].map(([v, label]) => (
            <button key={v} type="button" aria-pressed={filters.category === v} onClick={() => set("category", v)}
              className={cn("rounded-full border px-4 py-1.5 text-sm transition-colors", filters.category === v ? "border-ink bg-ink text-paper" : "border-control hover:bg-linen")}>{label}</button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3 lg:max-w-2xl">
          <Select label="Color" value={filters.color} onChange={(e) => set("color", e.target.value)}><option value="">Todos</option>{COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          <Select label="Temporada" value={filters.season} onChange={(e) => set("season", e.target.value)}><option value="">Todas</option>{SEASONS.map((s) => <option key={s} value={s}>{SEASON_LABELS[s]}</option>)}</Select>
          <Select label="Disponibilidad" value={filters.status} onChange={(e) => set("status", e.target.value)}><option value="">Todas</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={filters.favorite} onClick={() => set("favorite", !filters.favorite)} className={cn("rounded-full border px-4 py-1.5 text-sm", filters.favorite ? "border-ink bg-ink text-paper" : "border-control hover:bg-linen")}>Favoritas</button>
          <button type="button" aria-pressed={filters.needsReview} onClick={() => set("needsReview", !filters.needsReview)} className={cn("rounded-full border px-4 py-1.5 text-sm", filters.needsReview ? "border-ink bg-ink text-paper" : "border-control hover:bg-linen")}>Por revisar</button>
          {active && <Button variant="ghost" size="sm" onClick={() => { setTouched(true); setFilters(EMPTY); }}>Quitar filtros</Button>}
        </div>
      </div>

      {/* Resultado de la búsqueda y los filtros para lectores de pantalla. Región siempre montada (las regiones que aparecen ya con texto no se
          anuncian de forma fiable) y vacía mientras carga, así no se anuncia nada en cada pulsación: solo el resultado ya asentado. */}
      <p role="status" className="sr-only">{!touched || loading ? "" : items.length === 0 ? (active ? "Ninguna prenda con estos filtros" : "Tu armario está vacío") : `${items.length} ${items.length === 1 ? "prenda" : "prendas"}${cursor ? ", hay más por cargar" : ""}`}</p>
      <div className="mt-10">
        {loading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[4/5]" />)}</div>
        ) : items.length === 0 ? (
          <div className="rounded-card bg-linen p-10 text-center">
            <p className="font-display text-4xl">{active ? "Nada con estos filtros" : "Tu armario está vacío"}</p>
            <p className="mx-auto mt-2 max-w-sm text-taupe">{active ? "Prueba a quitar algún filtro." : "Sube fotos de tu ropa y la IA las catalogará por ti."}</p>
            {!active && <Button className="mt-6" onClick={() => setAdding(true)}>Añadir mi primera prenda</Button>}
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((it) => <li key={it.id}><ItemCard item={it} onOpen={() => setEditing(it)} onToggleFavorite={() => void toggleFavorite(it)} /></li>)}
            </ul>
            {cursor && <div className="mt-10 text-center"><Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>Cargar más</Button></div>}
          </>
        )}
      </div>

      <ItemEditor item={editing} onClose={() => setEditing(null)}
        onSaved={(u) => setItems((s) => s.map((i) => (i.id === u.id ? u : i)))}
        onDeleted={(id) => setItems((s) => s.filter((i) => i.id !== id))} />
      <AddItems open={adding} onClose={() => { setAdding(false); void load(filters); }} onAdded={(n) => setItems((s) => [...n, ...s])} />
    </div>
  );
}
