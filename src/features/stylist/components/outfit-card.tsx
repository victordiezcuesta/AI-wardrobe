"use client";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Heart, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button, Tooltip, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";
import { COLOR_SWATCH, type ColorKey } from "@/features/wardrobe/constants";
import type { AlternativeItems, OutfitDTO } from "../types";

type FeedbackType = "LIKE" | "DISLIKE" | "WORN" | "DISCARDED";

function Thumb({ url, name, color, className }: { url: string | null; name: string; color: string | null; className?: string }) {
  return (
    <div className={cn("relative aspect-[4/5] overflow-hidden rounded-2xl bg-sand", className)}>
      {url ? <Image src={url} alt={name} fill unoptimized sizes="160px" className="object-cover" />
        : <div className="absolute inset-0" style={{ background: COLOR_SWATCH[(color ?? "otro") as ColorKey] ?? COLOR_SWATCH.otro }} />}
    </div>
  );
}

interface Props { outfit: OutfitDTO; alternatives: AlternativeItems; onChange: (o: OutfitDTO, alt: AlternativeItems) => void; onDiscard: (id: string) => void }

export function OutfitCard({ outfit, alternatives, onChange, onDiscard }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function send(type: FeedbackType) {
    setBusy(type);
    try {
      const res = await api<{ outfit: OutfitDTO; alternativeItems: AlternativeItems }>(`/api/outfits/${outfit.id}/feedback`, { method: "POST", json: { type } });
      if (type === "DISCARDED") { onDiscard(outfit.id); toast.info("Conjunto descartado. Lo tendremos en cuenta."); }
      else {
        onChange(res.outfit, res.alternativeItems);
        toast.success(type === "WORN" ? "Anotado: te lo pones hoy" : type === "LIKE" ? "Me alegra que te guste" : "Anotado, propondremos menos así");
      }
    } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo registrar"); }
    finally { setBusy(null); }
  }

  async function toggleFavorite() {
    setBusy("FAV");
    try {
      const res = await api<{ outfit: OutfitDTO; alternativeItems: AlternativeItems }>(`/api/outfits/${outfit.id}`, { method: "PATCH", json: { isFavorite: !outfit.isFavorite } });
      onChange(res.outfit, res.alternativeItems);
    } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo actualizar"); }
    finally { setBusy(null); }
  }

  const alts = outfit.items.flatMap((oi) => oi.alternatives.map((id) => ({ replaces: oi.item.name, item: alternatives[id] }))).filter((a) => a.item);

  return (
    <article className="rounded-card bg-linen p-5 shadow-soft sm:p-7">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-4xl leading-tight">{outfit.name}</h3>
          {outfit.occasion && <p className="mt-1 text-sm text-taupe">{outfit.occasion}</p>}
        </div>
        <Tooltip text={outfit.isFavorite ? "Quitar de favoritos" : "Guardar en favoritos"}>
          <button type="button" onClick={toggleFavorite} disabled={busy === "FAV"} aria-pressed={outfit.isFavorite} aria-label="Favorito" className="grid size-10 place-items-center rounded-full bg-paper shadow-soft">
            <Heart className={cn("size-5", outfit.isFavorite && "fill-ink")} aria-hidden />
          </button>
        </Tooltip>
      </header>

      <ul className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        {outfit.items.map(({ item }) => (
          <li key={item.id}>
            <Thumb url={item.thumbUrl} name={item.name} color={item.primaryColor} />
            <p className="mt-1.5 truncate text-xs">{item.name}</p>
          </li>
        ))}
      </ul>

      <p className="mt-5 max-w-prose">{outfit.description}</p>
      <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        {([["Por qué funciona", outfit.reasoning], ["Colores", outfit.colorNotes], ["Clima", outfit.weatherNotes], ["Tu estilo", outfit.styleFit]] as const).map(([k, v]) => v && (
          <div key={k}><dt className="font-medium">{k}</dt><dd className="mt-0.5 text-taupe">{v}</dd></div>
        ))}
      </dl>

      {alts.length > 0 && (
        <div className="mt-5">
          <p className="text-sm font-medium">Alternativas</p>
          <ul className="mt-2 flex flex-wrap gap-3">
            {alts.map((a, i) => (
              <li key={`${a.item!.id}-${i}`} className="flex w-44 items-center gap-2 rounded-2xl bg-paper p-2 text-xs">
                <Thumb url={a.item!.thumbUrl} name={a.item!.name} color={a.item!.primaryColor} className="w-10 shrink-0 rounded-lg" />
                <span className="min-w-0"><span className="block truncate font-medium">{a.item!.name}</span><span className="block truncate text-taupe">en vez de {a.replaces}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="mt-6 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void send("WORN")} loading={busy === "WORN"}><Check className="size-4" aria-hidden />Me lo pongo</Button>
        <Button size="sm" variant="secondary" onClick={() => void send("LIKE")} loading={busy === "LIKE"}><ThumbsUp className="size-4" aria-hidden />Me gusta</Button>
        <Button size="sm" variant="ghost" onClick={() => void send("DISLIKE")} loading={busy === "DISLIKE"}><ThumbsDown className="size-4" aria-hidden />No me convence</Button>
        <Link href={`/try-on?outfit=${outfit.id}`} className="inline-flex h-9 items-center rounded-full bg-sand px-4 text-sm font-medium transition-colors hover:bg-stone/60">Ver cómo me queda</Link>
        <Button size="sm" variant="ghost" onClick={() => void send("DISCARDED")} loading={busy === "DISCARDED"}>Descartar</Button>
      </footer>
    </article>
  );
}
