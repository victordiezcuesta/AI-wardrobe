"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Skeleton, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";
import type { AlternativeItems, OutfitDTO, PlaceDTO, WeatherDTO } from "../types";
import { StylistForm, type StylistFormValues } from "./stylist-form";
import { WeatherCard } from "./weather-card";
import { OutfitCard } from "./outfit-card";

type Scope = "recent" | "favorites";
const LOADING_STEPS = ["Revisando tu armario…", "Consultando el clima…", "Combinando colores y estilos…", "Afinando los conjuntos…"];

export function StylistView() {
  const toast = useToast();
  const [place, setPlace] = useState<PlaceDTO | null>(null);
  const [date, setDate] = useState("");
  const [weatherState, setWeatherState] = useState<{ key: string; data: WeatherDTO } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [step, setStep] = useState(0);
  const [results, setResults] = useState<OutfitDTO[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [alts, setAlts] = useState<AlternativeItems>({});
  const [scope, setScope] = useState<Scope>("recent");
  const [history, setHistory] = useState<OutfitDTO[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [needsItems, setNeedsItems] = useState(false);
  const weatherReq = useRef(0);

  // Clima en cuanto hay lugar y fecha (llamada ligera, cacheada en servidor).
  const weatherKey = place && date ? `${place.latitude},${place.longitude},${date}` : null;
  const weather = weatherState && weatherState.key === weatherKey ? weatherState.data : null; // derivado: sin reset síncrono
  useEffect(() => {
    if (!place || !date || !weatherKey) return;
    const id = ++weatherReq.current;
    api<{ weather: WeatherDTO }>(`/api/weather?lat=${place.latitude}&lon=${place.longitude}&date=${date}`)
      .then((r) => { if (id === weatherReq.current) setWeatherState({ key: weatherKey, data: r.weather }); })
      .catch((e) => { if (id === weatherReq.current) toast.error(e instanceof Error ? e.message : "No se pudo obtener el clima"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherKey]);

  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api<{ outfits: OutfitDTO[]; alternativeItems: AlternativeItems }>(`/api/outfits?scope=${scope}`)
      .then((r) => { if (!cancelled) { setHistory(r.outfits); setAlts((a) => ({ ...a, ...r.alternativeItems })); setHistoryLoading(false); } })
      .catch(() => { if (!cancelled) { setHistory([]); setHistoryLoading(false); } });
    return () => { cancelled = true; };
  }, [scope, refreshTick]);
  const changeScope = (s: Scope) => { setHistoryLoading(true); setScope(s); };

  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => setStep((s) => (s + 1) % LOADING_STEPS.length), 2500);
    return () => clearInterval(t);
  }, [generating]);

  async function generate(v: StylistFormValues) {
    setGenerating(true); setStep(0); setWarning(null); setNeedsItems(false);
    try {
      const r = await api<{ outfits: OutfitDTO[]; alternativeItems: AlternativeItems; warning: string | null }>("/api/stylist/generate", { method: "POST", json: v });
      setResults(r.outfits); setAlts((a) => ({ ...a, ...r.alternativeItems })); setWarning(r.warning);
      setRefreshTick((n) => n + 1);
      requestAnimationFrame(() => document.getElementById("resultados")?.scrollIntoView({ behavior: "smooth" }));
    } catch (e) {
      const code = (e as { status?: number }).status;
      if (code === 422 && e instanceof Error && e.message.includes("prendas disponibles")) setNeedsItems(true);
      toast.error(e instanceof Error ? e.message : "No se pudieron generar conjuntos");
    } finally { setGenerating(false); }
  }

  const patch = (setter: React.Dispatch<React.SetStateAction<OutfitDTO[]>>) => (o: OutfitDTO, a: AlternativeItems) => {
    setter((s) => s.map((x) => (x.id === o.id ? o : x)));
    setAlts((prev) => ({ ...prev, ...a }));
    // Mantener sincronizadas las dos listas si el mismo conjunto aparece en ambas.
    setResults((s) => s.map((x) => (x.id === o.id ? o : x)));
    setHistory((s) => (scope === "favorites" && !o.isFavorite ? s.filter((x) => x.id !== o.id) : s.map((x) => (x.id === o.id ? o : x))));
  };
  const discard = (id: string) => { setResults((s) => s.filter((x) => x.id !== id)); setHistory((s) => s.filter((x) => x.id !== id)); };

  return (
    <div className="space-y-14">
      <section>
        <h1 className="font-display text-6xl leading-none">Estilista</h1>
        <p className="mt-4 max-w-xl text-taupe">Cuéntanos el plan. Solo propondremos prendas que están en tu armario y disponibles.</p>
        <div className="mt-10"><StylistForm place={place} onPlace={setPlace} date={date} onDate={setDate} loading={generating} onSubmit={generate} /></div>
        {weather && place && <div className="mt-8"><WeatherCard weather={weather} place={place.name} /></div>}
        {needsItems && <p className="mt-6 rounded-card bg-linen p-5">Aún no hay suficientes prendas. <Link href="/wardrobe" className="underline">Añade algunas a tu armario</Link> y vuelve.</p>}
      </section>

      {generating && (
        <section aria-live="polite" className="space-y-4">
          <p className="font-display text-3xl">{LOADING_STEPS[step]}</p>
          <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
        </section>
      )}

      {!generating && results.length > 0 && (
        <section id="resultados" className="scroll-mt-6 space-y-6">
          <h2 className="font-display text-5xl leading-none">Tus conjuntos</h2>
          {warning && <p className="rounded-card bg-linen p-4 text-sm">{warning}</p>}
          <div className="grid gap-6 xl:grid-cols-2">
            {results.map((o) => <OutfitCard key={o.id} outfit={o} alternatives={alts} onChange={patch(setResults)} onDiscard={discard} />)}
          </div>
        </section>
      )}

      <section className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-5xl leading-none">Tus conjuntos anteriores</h2>
          <div className="flex gap-2" role="group" aria-label="Filtrar historial">
            {([["recent", "Recientes"], ["favorites", "Favoritos"]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={scope === k} onClick={() => changeScope(k)} className={cn("rounded-full border px-4 py-1.5 text-sm", scope === k ? "border-ink bg-ink text-paper" : "border-stone/70 hover:bg-linen")}>{label}</button>
            ))}
          </div>
        </div>
        {historyLoading ? <Skeleton className="h-48" /> : history.length === 0 ? (
          <p className="text-taupe">{scope === "favorites" ? "Aún no has guardado ningún conjunto." : "Todavía no has pedido conjuntos."}</p>
        ) : (
          <div className="grid gap-6 xl:grid-cols-2">
            {history.map((o) => <OutfitCard key={o.id} outfit={o} alternatives={alts} onChange={patch(setHistory)} onDiscard={discard} />)}
          </div>
        )}
      </section>
    </div>
  );
}
