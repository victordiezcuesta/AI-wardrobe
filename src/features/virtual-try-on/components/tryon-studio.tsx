"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Wand2 } from "lucide-react";
import { Button, Select, Skeleton, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";
import type { OutfitDTO } from "@/features/stylist/types";
import { POSES, SCENARIOS, type PoseKey, type ScenarioKey } from "../constants";
import type { ConsentDTO, JobStatus, PhotoDTO, TryOnDTO } from "../types";

/** Anuncios del ciclo de una generación (la región de estado es persistente; el contador de la tarjeta NO se anuncia). */
export const TRYON_ANNOUNCEMENTS = {
  started: "Generando tu imagen. Puede tardar un minuto.",
  retrying: "Reintentando la generación.",
  done: "Tu imagen está lista. La encontrarás en tu historial.",
} as const;
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
  // Anuncio vigente: cada anuncio es un NODO nuevo de la región (`key` = número de secuencia). Un texto idéntico al anterior (dos trabajos que terminan seguidos) no cambiaría el
  // DOM si solo se sustituyera el texto y el segundo no se anunciaría; con un nodo nuevo por anuncio sí es una adición a la región.
  const [announcement, setAnnouncement] = useState<{ seq: number; text: string } | null>(null);
  const announceSeq = useRef(0);
  const announce = useCallback((text: string) => setAnnouncement({ seq: ++announceSeq.current, text }), []);
  // Último estado conocido de CADA trabajo (por id): solo las TRANSICIONES se anuncian (el sondeo repite el mismo estado cada 3 s) y una respuesta más antigua que la ya
  // vista (sondeos solapados que llegan desordenados) se descarta por `updatedAt`.
  const jobSeen = useRef(new Map<string, { status: JobStatus; updatedAt: string }>());
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
      for (const i of h.images) jobSeen.current.set(i.id, { status: i.status, updatedAt: i.updatedAt });
      setReady(true);
    }).catch((e) => { if (!cancelled) { toast.error(e instanceof Error ? e.message : "No se pudo cargar el probador"); setReady(true); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJobUpdate = useCallback((j: TryOnDTO) => {
    const prev = jobSeen.current.get(j.id);
    if (prev?.status === "COMPLETED") return;                         // ya terminado: cualquier respuesta posterior (duplicada o desordenada) se ignora, y no se vuelve a anunciar
    if (prev && j.updatedAt < prev.updatedAt) return;                 // más antigua que la última vista: obsoleta (los ISO se ordenan como texto)
    jobSeen.current.set(j.id, { status: j.status, updatedAt: j.updatedAt });
    if (j.status === "COMPLETED") announce(TRYON_ANNOUNCEMENTS.done);
    else if (prev?.status === "FAILED" && (j.status === "PENDING" || j.status === "PROCESSING")) announce(TRYON_ANNOUNCEMENTS.retrying);
    if (j.status === "COMPLETED") {
      setJobs((s) => s.filter((x) => x.id !== j.id));
      setHistory((h) => [j, ...h.filter((x) => x.id !== j.id)]);
    } else setJobs((s) => s.map((x) => (x.id === j.id ? j : x)));
  }, [announce]);

  async function generate() {
    if (!outfitId || !photoId) return;
    setCreating(true);
    try {
      const { image } = await api<{ image: TryOnDTO }>("/api/try-on", { method: "POST", json: { outfitId, photoPublicId: photoId, scenario, pose } });
      setJobs((s) => [image, ...s]);
      jobSeen.current.set(image.id, { status: image.status, updatedAt: image.updatedAt });
      announce(TRYON_ANNOUNCEMENTS.started);
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
              <OutfitPicker outfits={outfits} value={outfitId} onChange={setOutfitId} />
            )}
            <div className="grid max-w-xl gap-4 sm:grid-cols-2">
              <Select label="Escenario" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioKey)}>{SCENARIOS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
              <Select label="Pose" value={pose} onChange={(e) => setPose(e.target.value as PoseKey)}>{POSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
            </div>
            <Button size="lg" onClick={() => void generate()} loading={creating} disabled={!canGenerate}><Wand2 className="size-4" aria-hidden />Ver cómo me queda</Button>
            {!canGenerate && <p className="text-sm text-taupe">Necesitas una foto y un conjunto seleccionados.</p>}
            <p className="max-w-xl text-xs text-taupe">Al generar, tu foto y las de las prendas se envían a Pollinations.ai. No se generan imágenes sin que pulses el botón.</p>
          </section>

          {/* Región de estado SIEMPRE montada: inicio, reintento y final de la generación. Un fallo lo anuncia la propia tarjeta (`role="alert"`). */}
          <p role="status" aria-atomic="false" className="sr-only">{announcement && <span key={announcement.seq}>{announcement.text}</span>}</p>
          {jobs.length > 0 && <section className="space-y-4" aria-label="En proceso">{jobs.map((j) => <JobCard key={j.id} job={j} onUpdate={onJobUpdate} />)}</section>}
        </>
      )}

      <section className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-5xl leading-none">Tu historial</h2>
          <button type="button" aria-pressed={onlyFavs} onClick={() => setOnlyFavs((v) => !v)} className={cn("rounded-full border px-4 py-1.5 text-sm", onlyFavs ? "border-ink bg-ink text-paper" : "border-control hover:bg-linen")}>Solo favoritas</button>
        </div>
        <History images={shown} hasMore={!!cursor && !onlyFavs} loadingMore={loadingMore} onMore={() => void loadMore()}
          onChange={(i) => setHistory((h) => h.map((x) => (x.id === i.id ? i : x)))} onRemove={(id) => setHistory((h) => h.filter((x) => x.id !== id))} />
      </section>
    </div>
  );
}

/**
 * Selector de conjunto: radios HTML NATIVOS (una sola parada de Tab, flechas con vuelta y selección automática las gestiona el navegador).
 * El `input` es `sr-only`; el foco visible se pinta en la tarjeta con `has-[:focus-visible]`. Cada radio se nombra con el nombre del conjunto
 * y su posición («… (conjunto 2 de 3)», para distinguir nombres repetidos) y se describe con sus prendas (`aria-describedby`).
 * La tarjeta es `relative`: el `sr-only` es `position:absolute`, y así su caja queda DENTRO de la tarjeta, que se desplaza con la tira (`overflow-x-auto`);
 * sin ancestro posicionado el navegador podría no desplazar la tira hasta el radio enfocado con las flechas.
 */
export function OutfitPicker({ outfits, value, onChange }: { outfits: OutfitDTO[]; value: string | null; onChange: (id: string) => void }) {
  const group = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Conjuntos</legend>
      {/* `overflow-x-auto` recorta también en vertical todo lo que sobresale de su caja: el contorno de foco de la tarjeta (2 px + 4 px de separación = 6 px) y el anillo
          de selección (2 px). El relleno de 8 px (`p-2`) les deja sitio por los cuatro lados; los márgenes negativos compensan arriba y a los lados para que la
          tira ocupe y se alinee exactamente como antes (antes: solo `pb-2` abajo). */}
      <ul className="-mx-2 -mt-2 flex gap-4 overflow-x-auto p-2">
        {outfits.map((o, i) => {
          const checked = value === o.id;
          const descId = `${group}-desc-${o.id}`;
          const pieces = o.items.map(({ item }) => item.name).join(", ");
          return (
            <li key={o.id} className="shrink-0">
              <label className={cn("relative block w-48 cursor-pointer rounded-card p-3 text-left transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ink",
                checked ? "bg-linen ring-2 ring-ink" : "bg-linen/60 ring-1 ring-control hover:bg-linen")}>
                <input type="radio" name={group} value={o.id} checked={checked} onChange={() => onChange(o.id)} aria-describedby={descId} className="sr-only" />
                <span className="flex gap-1.5">
                  {o.items.slice(0, 3).map(({ item }) => (
                    <span key={item.id} className="relative aspect-[4/5] flex-1 overflow-hidden rounded-lg bg-sand">
                      {item.thumbUrl && <Image src={item.thumbUrl} alt="" fill unoptimized sizes="64px" className="object-cover" />}
                    </span>
                  ))}
                </span>
                <span className="mt-2 block truncate text-sm font-medium">{o.name}{" "}<span className="sr-only">(conjunto {i + 1} de {outfits.length})</span></span>
              </label>
              <span id={descId} className="sr-only">{pieces ? `Prendas: ${pieces}` : "Sin prendas"}</span>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
