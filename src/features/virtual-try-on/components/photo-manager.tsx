"use client";
import { useRef, useState } from "react";
import { Check, ImagePlus, Trash2 } from "lucide-react";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { api, ApiError } from "@/utils/api";
import { prepareImage } from "@/utils/image";
import { cn } from "@/utils/cn";
import { MAX_PERSONAL_PHOTOS } from "../constants";
import type { PhotoDTO } from "../types";

interface Props { photos: PhotoDTO[]; selected: string | null; onSelect: (id: string) => void; onChange: (photos: PhotoDTO[]) => void }

export function PhotoManager({ photos, selected, onSelect, onChange }: Props) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [toDelete, setToDelete] = useState<PhotoDTO | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const prepared = await prepareImage(file);
      const fd = new FormData();
      fd.set("file", prepared);
      const res = await fetch("/api/photos", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data?.error?.message ?? "No se pudo subir la foto", res.status);
      const photo = (data as { photo: PhotoDTO }).photo;
      onChange([...photos, photo]);
      onSelect(photo.publicId);
    } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo subir la foto"); }
    finally { setUploading(false); }
  }

  async function remove(p: PhotoDTO) {
    await api(`/api/photos?publicId=${encodeURIComponent(p.publicId)}`, { method: "DELETE" });
    const next = photos.filter((x) => x.publicId !== p.publicId);
    onChange(next);
    if (selected === p.publicId && next[0]) onSelect(next[0].publicId);
    toast.success("Foto eliminada");
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-4xl leading-none">Tus fotos</h2>
        <span className="text-sm text-taupe">{photos.length}/{MAX_PERSONAL_PHOTOS}</span>
      </div>
      <p className="max-w-xl text-sm text-taupe">Mejor una foto de cuerpo entero, de frente, con buena luz y sin gafas de sol ni filtros.</p>
      <ul className="flex flex-wrap gap-4">
        {photos.map((p, index) => {
          const position = `${index + 1} de ${photos.length}`;   // posición en la lista ACTUAL: nombres únicos y correctos tras eliminar
          return (
          <li key={p.publicId} className="relative">
            <button type="button" onClick={() => onSelect(p.publicId)} aria-pressed={selected === p.publicId} aria-label={`Usar foto ${position}`}
              className={cn("block overflow-hidden rounded-card ring-2 ring-offset-2 ring-offset-paper transition", selected === p.publicId ? "ring-ink" : "ring-transparent")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="" className="h-44 w-32 object-cover" />
            </button>
            {selected === p.publicId && <span className="absolute left-2 top-2 grid size-6 place-items-center rounded-full bg-ink text-paper"><Check className="size-3.5" aria-hidden /></span>}
            <button type="button" onClick={() => setToDelete(p)} aria-label={`Eliminar foto ${position}`} className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-paper/90 shadow-soft"><Trash2 className="size-4" /></button>
          </li>
          );
        })}
        {photos.length < MAX_PERSONAL_PHOTOS && (
          <li>
            <button type="button" onClick={() => input.current?.click()} disabled={uploading}
              className="grid h-44 w-32 place-items-center rounded-card border border-dashed border-control bg-linen text-sm text-taupe hover:border-ink hover:bg-sand hover:text-ink disabled:opacity-60">
              <span className="flex flex-col items-center gap-2"><ImagePlus className="size-5" aria-hidden />{uploading ? "Subiendo…" : "Añadir foto"}</span>
            </button>
          </li>
        )}
      </ul>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      <ConfirmDialog open={!!toDelete} title="¿Eliminar esta foto?" description="Se borrará de forma definitiva de nuestro almacenamiento. Las imágenes ya generadas no se eliminan."
        confirmLabel="Eliminar" destructive onConfirm={() => toDelete ? remove(toDelete) : undefined} onClose={() => setToDelete(null)} />
      {photos.length === 0 && <Button variant="secondary" onClick={() => input.current?.click()} loading={uploading}>Subir mi primera foto</Button>}
    </section>
  );
}
