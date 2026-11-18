"use client";
import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Wand2 } from "lucide-react";
import { Button, Select, Skeleton, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";
import type { OutfitDTO } from "@/features/stylist/types";
import { POSES, SCENARIOS, type PoseKey, type ScenarioKey } from "../constants";
import type { ConsentDTO, PhotoDTO, TryOnDTO } from "../types";
import { ConsentCard } from "./consent-card";
import { PhotoManager } from "./photo-manager";
import { JobCard } from "./job-card";
import { History } from "./history";

export function TryOnStudio() {
  const toast = useToast();
  const preselected = useSearchParams().get("outfit");
  const [ready, setReady] = useState(false);
  const [consent, setConsent] = useState<ConsentDTO>({ granted: false, at: null, version: "" });
  const [photos, setPhotos] = useState<PhotoDTO[]>([]);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [outfits, setOutfits] = useState<OutfitDTO[]>([]);
  const [outfitId, setOutfitId] = useState<string | null>(preselected);
  const [scenario, setScenario] = useState<ScenarioKey>("studio");
  const [pose, setPose] = useState<PoseKey>("standing");
  const [jobs, setJobs] = useState<TryOnDTO[]>([]);
  const [history, setHistory] = useState<TryOnDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [onlyFavs, setOnlyFavs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<ConsentDTO>("/api/consent"),
      api<{ photos: PhotoDTO[] }>("/api/photos"),
      api<{ outfits: OutfitDTO[] }>("/api/outfits?scope=recent"),
      api<{ images: TryOnDTO[]; nextCursor: string | null }>("/api/try-on"),
    ]).then(async ([c, p, o, h]) => {
      if (cancelled) return;
      let list = o.outfits;
      if (preselected && !list.some((x) => x.id === preselected)) {
        try { list = [(await api<{ outfit: OutfitDTO }>(`/api/outfits/${preselected}`)).outfit, ...list]; } catch { /* conjunto inexistente: se ignora */ }
      }
      if (cancelled) return;
      setConsent(c); setPhotos(p.photos); setPhotoId(p.photos[0]?.publicId ?? null); setOutfits(list);
      setHistory(h.images.filter((i) => i.status === "COMPLETED")); setJobs(h.images.filter((i) => i.status !== "COMPLETED")); setCursor(h.nextCursor);
      setReady(true);
    }).catch((e) => { if (!cancelled) { toast.error(e instanceof Error ? e.message : "No se pudo cargar el probador"); setReady(true); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJobUpdate = useCallback((j: TryOnDTO) => {
    if (j.status === "COMPLETED") {
      setJobs((s) => s.filter((x) => x.id !== j.id));
      setHistory((h) => [j, ...h.filter((x) => x.id !== j.id)]);
    } else setJobs((s) => s.map((x) => (x.id === j.id ? j : x)));
  }, []);

  async function generate() {
    if (!outfitId || !photoId) return;
    setCreating(true);
    try {
      const { image } = await api<{ image: TryOnDTO }>("/api/try-on", { method: "POST", json: { outfitId, photoPublicId: photoId, scenario, pose } });
      setJobs((s) => [image, ...s]);
    } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo iniciar la generación"); }
    finally { setCreating(false); }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api<{ images: TryOnDTO[]; nextCursor: string | null }>(`/api/try-on?cursor=${cursor}`);
      setHistory((h) => [...h, ...r.images.filter((i) => i.status === "COMPLETED")]); setCursor(r.nextCursor);
    } finally { setLoadingMore(false); }
  }

  if (!ready) return <div className="space-y-6"><Skeleton className="h-16 w-72" /><Skeleton className="h-64" /></div>;

  const shown = onlyFavs ? history.filter((i) => i.isFavorite) : history;
  const canGenerate = consent.granted && !!photoId && !!outfitId;

  return (
    <div className="space-y-14">
      <section>
        <h1 className="font-display text-6xl leading-none">Probador virtual</h1>
        <p className="mt-4 max-w-xl text-taupe">Mira cómo te quedaría un conjunto. Es una recreación con IA: orientativa, no una prueba exacta.</p>
        <div className="mt-8"><ConsentCard consent={consent} onChange={setConsent} /></div>
      </section>

      {consent.granted && (
        <>
          <PhotoManager photos={photos} selected={photoId} onSelect={setPhotoId} onChange={setPhotos} />

          <section className="space-y-5">
            <h2 className="font-display text-4xl leading-none">Elige un conjunto</h2>
            {outfits.length === 0 ? (
              <p className="text-taupe">Aún no tienes conjuntos. <Link href="/stylist" className="underline">Pídele uno al estilista</Link>.</p>
            ) : (
              <ul className="flex gap-4 overflow-x-auto pb-2" role="radiogroup" aria-label="Conjuntos">
                {outfits.map((o) => (
                  <li key={o.id} className="shrink-0">
                    <button type="button" role="radio" aria-checked={outfitId === o.id} onClick={() => setOutfitId(o.id)}
                      className={cn("w-48 rounded-card p-3 text-left ring-2 transition", outfitId === o.id ? "bg-linen ring-ink" : "bg-linen/60 ring-transparent hover:bg-linen")}>
                      <span className="flex gap-1.5">
                        {o.items.slice(0, 3).map(({ item }) => (
                          <span key={item.id} className="relative aspect-[4/5] flex-1 overflow-hidden rounded-lg bg-sand">
                            {item.thumbUrl && <Image src={item.thumbUrl} alt="" fill unoptimized sizes="64px" className="object-cover" />}
                          </span>
                        ))}
                      </span>
                      <span className="mt-2 block truncate text-sm font-medium">{o.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid max-w-xl gap-4 sm:grid-cols-2">
              <Select label="Escenario" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioKey)}>{SCENARIOS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
              <Select label="Pose" value={pose} onChange={(e) => setPose(e.target.value as PoseKey)}>{POSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
            </div>
            <Button size="lg" onClick={() => void generate()} loading={creating} disabled={!canGenerate}><Wand2 className="size-4" aria-hidden />Ver cómo me queda</Button>
            {!canGenerate && <p className="text-sm text-taupe">Necesitas una foto y un conjunto seleccionados.</p>}
            <p className="max-w-xl text-xs text-taupe">Al generar, tu foto y las de las prendas se envían a Pollinations.ai. No se generan imágenes sin que pulses el botón.</p>
          </section>

          {jobs.length > 0 && <section className="space-y-4" aria-label="En proceso">{jobs.map((j) => <JobCard key={j.id} job={j} onUpdate={onJobUpdate} />)}</section>}
        </>
      )}

      <section className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-5xl leading-none">Tu historial</h2>
          <button type="button" aria-pressed={onlyFavs} onClick={() => setOnlyFavs((v) => !v)} className={cn("rounded-full border px-4 py-1.5 text-sm", onlyFavs ? "border-ink bg-ink text-paper" : "border-stone/70 hover:bg-linen")}>Solo favoritas</button>
        </div>
        <History images={shown} hasMore={!!cursor && !onlyFavs} loadingMore={loadingMore} onMore={() => void loadMore()}
          onChange={(i) => setHistory((h) => h.map((x) => (x.id === i.id ? i : x)))} onRemove={(id) => setHistory((h) => h.filter((x) => x.id !== id))} />
      </section>
    </div>
  );
}
