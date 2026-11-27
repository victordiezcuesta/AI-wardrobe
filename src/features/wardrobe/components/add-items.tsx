"use client";
import { useRef, useState } from "react";
import { Camera, Check, ImagePlus, Loader2, RotateCcw, X } from "lucide-react";
import { Button, Input, Modal, Select, Tabs, useToast } from "@/components/ui";
import { api, ApiError } from "@/utils/api";
import { prepareImage } from "@/utils/image";
import { CATEGORIES, CATEGORY_LABELS, COLORS } from "../constants";
import type { ItemDTO, UploadOutcomeDTO } from "../types";
import { cn } from "@/utils/cn";

type Mode = "single" | "multi";
interface Job { id: number; file: File; state: "queued" | "working" | "done" | "error"; message?: string }
interface Props { open: boolean; onClose: () => void; onAdded: (items: ItemDTO[]) => void }

let nextId = 1;
const ADD_TABS = [{ key: "photos", label: "Con fotos" }, { key: "manual", label: "Manualmente" }] as const;

export function AddItems({ open, onClose, onAdded }: Props) {
  const toast = useToast();
  const [tab, setTab] = useState<"photos" | "manual">("photos");
  const [mode, setMode] = useState<Mode>("single");
  const [jobs, setJobs] = useState<Job[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);
  const running = jobs.some((j) => j.state === "working");

  const patch = (id: number, p: Partial<Job>) => setJobs((s) => s.map((j) => (j.id === id ? { ...j, ...p } : j)));

  async function runJob(job: Job, m: Mode) {
    patch(job.id, { state: "working", message: undefined });
    try {
      const prepared = await prepareImage(job.file);
      const fd = new FormData();
      fd.set("file", prepared);
      fd.set("mode", m);
      const res = await fetch("/api/wardrobe/analyze", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data?.error?.message ?? "Error al subir", res.status);
      const out = data as UploadOutcomeDTO;
      if (out.status === "no_garment") return patch(job.id, { state: "error", message: "No se ha detectado ninguna prenda en esta foto." });
      onAdded(out.items);
      patch(job.id, {
        state: "done",
        message: out.status === "analysis_failed"
          ? "Guardada sin analizar (la IA no respondió). Complétala a mano."
          : `${out.items.length} ${out.items.length === 1 ? "prenda añadida" : "prendas añadidas"}`,
      });
    } catch (err) {
      patch(job.id, { state: "error", message: err instanceof Error ? err.message : "Error inesperado" });
    }
  }

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const newJobs: Job[] = [...list].slice(0, 20).map((file) => ({ id: nextId++, file, state: "queued" }));
    setJobs((s) => [...s, ...newJobs]);
    // Concurrencia 2: rápido sin saturar la cuota de la IA ni el límite de funciones.
    const queue = [...newJobs];
    await Promise.all([0, 1].map(async () => { for (let j = queue.shift(); j; j = queue.shift()) await runJob(j, mode); }));
  }

  const photosPanel = (
    <div className="space-y-5">
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Tipo de foto</legend>
        {([["single", "Una prenda por foto"], ["multi", "Varias prendas en una foto"]] as const).map(([k, label]) => (
          <label key={k} className={cn("relative cursor-pointer rounded-field border px-4 py-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink", mode === k ? "border-ink bg-linen" : "border-control")}>
            <input type="radio" name="mode" className="sr-only" checked={mode === k} onChange={() => setMode(k)} />{label}
          </label>
        ))}
      </fieldset>
      {mode === "multi" && <p className="text-sm text-taupe">La IA localiza cada prenda y la recorta. Si no puede hacerlo con precisión, la prenda se guarda marcada para que la revises.</p>}

      <div className="flex flex-wrap gap-3">
        <Button onClick={() => fileInput.current?.click()}><ImagePlus className="size-4" aria-hidden />Elegir fotos</Button>
        <Button variant="secondary" onClick={() => camInput.current?.click()}><Camera className="size-4" aria-hidden />Hacer foto</Button>
      </div>
      <input ref={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
      <input ref={camInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />

      {jobs.length > 0 && (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3 rounded-field bg-linen px-4 py-2.5 text-sm">
              <span className="shrink-0">
                {j.state === "working" || j.state === "queued" ? <Loader2 className="size-4 animate-spin" aria-label="Procesando" /> : j.state === "done" ? <Check className="size-4" aria-label="Hecho" /> : <X className="size-4 text-danger" aria-label="Error" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{j.file.name}</span>
                <span className={cn("block text-xs", j.state === "error" ? "text-danger" : "text-taupe")}>
                  {j.state === "queued" ? "En cola" : j.state === "working" ? "Subiendo y analizando…" : j.message}
                </span>
              </span>
              {j.state === "error" && (
                <button type="button" onClick={() => void runJob(j, mode)} aria-label="Reintentar" className="rounded-full p-1.5 hover:bg-sand"><RotateCcw className="size-4" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {jobs.length > 0 && !running && <div className="flex justify-end"><Button variant="ghost" onClick={() => { setJobs([]); onClose(); }}>Listo</Button></div>}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Añadir prendas">
      {/* Los paneles permanecen montados (los inactivos, ocultos): lo escrito en el formulario manual no se pierde al cambiar de pestaña, con el
          ratón ni con las flechas. El estado vive lo que vive el diálogo: al cerrarlo, `Modal` desmonta su contenido y el formulario empieza vacío. */}
      <Tabs
        label="Forma de añadir prendas"
        tabs={ADD_TABS}
        value={tab}
        onChange={setTab}
        keepMounted
        panels={{ photos: photosPanel, manual: <ManualForm onCreated={(i) => { onAdded([i]); toast.success("Prenda añadida"); onClose(); }} /> }}
      />
    </Modal>
  );
}

function ManualForm({ onCreated }: { onCreated: (i: ItemDTO) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ItemDTO["category"]>("TSHIRT");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { item } = await api<{ item: ItemDTO }>("/api/wardrobe", { method: "POST", json: { name, category, primaryColor: color || null } });
      onCreated(item);
    } catch (err) { toast.error(err instanceof Error ? err.message : "No se pudo crear"); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required />
      <Select label="Categoría" value={category} onChange={(e) => setCategory(e.target.value as ItemDTO["category"])}>
        {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
      </Select>
      <Select label="Color principal" value={color} onChange={(e) => setColor(e.target.value)}>
        <option value="">Sin indicar</option>
        {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
      <p className="text-sm text-taupe">Podrás completar el resto de datos desde la ficha de la prenda.</p>
      <div className="flex justify-end"><Button type="submit" loading={busy} disabled={!name.trim()}>Añadir</Button></div>
    </form>
  );
}
