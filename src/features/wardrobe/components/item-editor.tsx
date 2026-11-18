"use client";
import { useState } from "react";
import Image from "next/image";
import { Button, ChipGroup, ConfirmDialog, Input, Modal, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/utils/api";
import { CATEGORIES, CATEGORY_LABELS, COLORS, SEASONS, SEASON_LABELS, STATUSES, STATUS_LABELS, type ColorKey, type SeasonKey } from "../constants";
import type { ItemDTO } from "../types";

interface Props { item: ItemDTO | null; onClose: () => void; onSaved: (item: ItemDTO) => void; onDeleted: (id: string) => void }

export function ItemEditor({ item, onClose, onSaved, onDeleted }: Props) {
  return (
    <Modal open={!!item} onClose={onClose} title={item?.name ?? ""}>
      {item && <EditorBody key={item.id} item={item} onClose={onClose} onSaved={onSaved} onDeleted={onDeleted} />}
    </Modal>
  );
}

function EditorBody({ item, onClose, onSaved, onDeleted }: { item: ItemDTO; onClose: () => void; onSaved: (i: ItemDTO) => void; onDeleted: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: item.name, category: item.category, subcategory: item.subcategory ?? "", description: item.description ?? "",
    primaryColor: item.primaryColor ?? "", secondaryColors: item.secondaryColors, pattern: item.pattern ?? "", material: item.material ?? "",
    seasons: item.seasons, formality: item.formality ? String(item.formality) : "", status: item.status,
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const { item: updated } = await api<{ item: ItemDTO }>(`/api/wardrobe/${item.id}`, {
        method: "PATCH",
        json: {
          name: f.name, category: f.category, subcategory: f.subcategory || null, description: f.description || null,
          primaryColor: f.primaryColor || null, secondaryColors: f.secondaryColors.filter((c) => c !== f.primaryColor),
          pattern: f.pattern || null, material: f.material || null, seasons: f.seasons,
          formality: f.formality ? Number(f.formality) : null, status: f.status,
          needsReview: false, // al guardar, el usuario confirma los datos
        },
      });
      onSaved(updated);
      toast.success("Prenda guardada");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? (err.issues?.[0]?.message ?? err.message) : "No se pudo guardar");
    } finally { setSaving(false); }
  }

  async function remove() {
    await api(`/api/wardrobe/${item.id}`, { method: "DELETE" });
    onDeleted(item.id);
    toast.success("Prenda eliminada");
    onClose();
  }

  return (
    <div className="space-y-5">
      {item.thumbUrl && (
        <div className="relative mx-auto aspect-[4/5] w-48 overflow-hidden rounded-card bg-sand">
          <Image src={item.thumbUrl} alt={item.name} fill unoptimized className="object-cover" />
        </div>
      )}
      {item.needsReview && (
        <p className="rounded-field bg-linen p-3 text-sm">La IA no estaba segura de algunos datos{item.aiConfidence != null && ` (confianza ${Math.round(item.aiConfidence * 100)}%)`}. Revísalos y pulsa «Guardar» para confirmarlos.</p>
      )}
      <Input label="Nombre" value={f.name} onChange={(e) => set("name", e.target.value)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Categoría" value={f.category} onChange={(e) => set("category", e.target.value as ItemDTO["category"])}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </Select>
        <Input label="Subcategoría" value={f.subcategory} onChange={(e) => set("subcategory", e.target.value)} />
        <Select label="Color principal" value={f.primaryColor} onChange={(e) => set("primaryColor", e.target.value as ColorKey | "")}>
          <option value="">Sin indicar</option>
          {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select label="Formalidad" value={f.formality} onChange={(e) => set("formality", e.target.value)}>
          <option value="">Sin indicar</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {["muy informal", "informal", "versátil", "formal", "muy formal"][n - 1]}</option>)}
        </Select>
        <Input label="Estampado" value={f.pattern} onChange={(e) => set("pattern", e.target.value)} />
        <Input label="Material" value={f.material} onChange={(e) => set("material", e.target.value)} />
      </div>
      <ChipGroup<ColorKey> label="Colores secundarios" options={COLORS.map((c) => ({ value: c, label: c }))} value={f.secondaryColors} onChange={(v) => set("secondaryColors", v)} />
      <ChipGroup<SeasonKey> label="Temporada" options={SEASONS.map((s) => ({ value: s, label: SEASON_LABELS[s] }))} value={f.seasons} onChange={(v) => set("seasons", v)} />
      <Select label="Disponibilidad" value={f.status} onChange={(e) => set("status", e.target.value as ItemDTO["status"])}>
        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
      </Select>
      <Textarea label="Descripción" value={f.description} onChange={(e) => set("description", e.target.value)} />
      <div className="flex flex-wrap justify-between gap-3 pt-2">
        <Button variant="ghost" onClick={() => setConfirmDelete(true)} className="text-danger">Eliminar</Button>
        <Button onClick={save} loading={saving} disabled={!f.name.trim()}>Guardar</Button>
      </div>
      <ConfirmDialog open={confirmDelete} title="¿Eliminar esta prenda?" description="Se borrará de tu armario y su foto se eliminará de forma definitiva." confirmLabel="Eliminar" destructive onConfirm={remove} onClose={() => setConfirmDelete(false)} />
    </div>
  );
}
