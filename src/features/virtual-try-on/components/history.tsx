"use client";
import { useState } from "react";
import { Download, Heart, Trash2 } from "lucide-react";
import { Button, ConfirmDialog, Modal, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { cn } from "@/utils/cn";
import { POSES, SCENARIOS } from "../constants";
import type { TryOnDTO } from "../types";

interface Props { images: TryOnDTO[]; hasMore: boolean; loadingMore: boolean; onMore: () => void; onChange: (i: TryOnDTO) => void; onRemove: (id: string) => void }

export function History({ images, hasMore, loadingMore, onMore, onChange, onRemove }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState<TryOnDTO | null>(null);
  const [del, setDel] = useState<TryOnDTO | null>(null);
  const done = images.filter((i) => i.status === "COMPLETED" && i.imageUrl);
  const label = (i: TryOnDTO) => `${SCENARIOS.find((s) => s.value === i.scenario)?.label ?? i.scenario} · ${POSES.find((p) => p.value === i.pose)?.label ?? i.pose}`;

  async function fav(i: TryOnDTO) {
    try { onChange((await api<{ image: TryOnDTO }>(`/api/try-on/${i.id}`, { method: "PATCH", json: { isFavorite: !i.isFavorite } })).image); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo actualizar"); }
  }

  if (done.length === 0) return <p className="text-taupe">Aquí aparecerán tus imágenes generadas.</p>;
  return (
    <>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {done.map((i, n) => {
          const where = `${n + 1} de ${done.length}`;   // varias imágenes comparten escenario y pose: la posición las distingue
          return (
          <li key={i.id} className="group relative">
            <button type="button" onClick={() => setOpen(i)} className="block w-full overflow-hidden rounded-card bg-sand" aria-label={`Abrir imagen ${where}: ${label(i)}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={i.imageUrl!} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
            </button>
            <button type="button" onClick={() => void fav(i)} aria-pressed={i.isFavorite} aria-label={`Favorita: imagen ${where}`} className="absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-paper/90 shadow-soft">
              <Heart className={cn("size-4", i.isFavorite && "fill-ink")} aria-hidden />
            </button>
            <p className="mt-1.5 truncate text-xs text-taupe">{label(i)}</p>
          </li>
          );
        })}
      </ul>
      {hasMore && <div className="mt-8 text-center"><Button variant="secondary" onClick={onMore} loading={loadingMore}>Cargar más</Button></div>}

      <Modal open={!!open} onClose={() => setOpen(null)} title="Tu imagen">
        {open && (
          <div className="space-y-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={open.imageUrl!} alt={label(open)} className="mx-auto max-h-[60dvh] rounded-card" />
            <p className="text-center text-xs text-taupe">Recreación generada con IA; puede no reflejar con exactitud tu aspecto ni las prendas.</p>
            <div className="flex flex-wrap justify-between gap-3">
              <Button variant="ghost" className="text-danger" onClick={() => setDel(open)}><Trash2 className="size-4" aria-hidden />Eliminar</Button>
              {/* El enlace firmado fuerza la descarga y caduca a los 15 minutos. */}
              <a href={open.downloadUrl!} download className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-6 text-[0.95rem] font-medium text-paper hover:bg-taupe"><Download className="size-4" aria-hidden />Descargar</a>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog open={!!del} title="¿Eliminar esta imagen?" description="Se borrará de forma definitiva, también de nuestro almacenamiento."
        confirmLabel="Eliminar" destructive
        onConfirm={async () => { if (!del) return; await api(`/api/try-on/${del.id}`, { method: "DELETE" }); onRemove(del.id); setOpen(null); toast.success("Imagen eliminada"); }}
        onClose={() => setDel(null)} />
    </>
  );
}
