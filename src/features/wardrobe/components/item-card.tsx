"use client";
import Image from "next/image";
import { AlertCircle, Heart } from "lucide-react";
import { cn } from "@/utils/cn";
import { COLOR_SWATCH, STATUS_LABELS } from "../constants";
import type { ItemDTO } from "../types";

export function ItemCard({ item, onOpen, onToggleFavorite }: { item: ItemDTO; onOpen: () => void; onToggleFavorite: () => void }) {
  const swatch = COLOR_SWATCH[item.primaryColor ?? "otro"];
  // El `aria-label` sustituye al contenido del botón: se incluyen en él el estado y «Revisar», que antes solo se veían.
  const openLabel = [`Abrir ${item.name}`, item.status !== "AVAILABLE" ? STATUS_LABELS[item.status] : null, item.needsReview ? "Revisar" : null].filter(Boolean).join(", ");
  return (
    <div className="group relative">
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={openLabel}>
        <div className={cn("relative aspect-[4/5] overflow-hidden rounded-card bg-sand", item.status !== "AVAILABLE" && "opacity-60")}>
          {item.thumbUrl ? (
            <Image src={item.thumbUrl} alt={item.name} fill unoptimized sizes="(min-width:1024px) 25vw, 50vw" className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
          ) : (
            <div className="absolute inset-0 grid place-items-center" style={{ background: swatch }}>
              <span className="rounded-full bg-paper/80 px-3 py-1 text-xs">Sin foto</span>
            </div>
          )}
          {item.status !== "AVAILABLE" && (
            <span className="absolute left-3 top-3 rounded-full bg-ink px-3 py-1 text-xs text-paper">{STATUS_LABELS[item.status]}</span>
          )}
          {item.needsReview && (
            <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-full bg-paper px-3 py-1 text-xs shadow-soft">
              <AlertCircle className="size-3.5" aria-hidden /> Revisar
            </span>
          )}
        </div>
        <p className="mt-2 truncate text-sm font-medium">{item.name}</p>
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-pressed={item.isFavorite}
        aria-label={`Favorita: ${item.name}`}
        className="absolute right-3 top-3 grid size-9 place-items-center rounded-full bg-paper/90 shadow-soft transition-transform hover:scale-105"
      >
        <Heart className={cn("size-4", item.isFavorite && "fill-ink")} aria-hidden />
      </button>
    </div>
  );
}
