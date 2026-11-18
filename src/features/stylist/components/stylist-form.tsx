"use client";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button, Input, Select, Textarea } from "@/components/ui";
import { STYLES } from "@/features/profile/constants";
import { cn } from "@/utils/cn";
import { OCCASION_EXAMPLES } from "../constants";
import type { PlaceDTO } from "../types";
import { LocationPicker } from "./location-picker";

export interface StylistFormValues {
  location: PlaceDTO; date: string; time?: string; occasion: string; activity?: string; formality?: number; style?: string; notes?: string;
}

interface Props { place: PlaceDTO | null; onPlace: (p: PlaceDTO | null) => void; date: string; onDate: (d: string) => void; loading: boolean; onSubmit: (v: StylistFormValues) => void }

export function StylistForm({ place, onPlace, date, onDate, loading, onSubmit }: Props) {
  const [time, setTime] = useState("");
  const [occasion, setOccasion] = useState("");
  const [activity, setActivity] = useState("");
  const [formality, setFormality] = useState("");
  const [style, setStyle] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => { if (!date) onDate(new Date().toLocaleDateString("en-CA")); }, [date, onDate]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!place) return;
    onSubmit({
      location: place, date, occasion: occasion.trim(),
      ...(time && { time }), ...(activity.trim() && { activity: activity.trim() }),
      ...(formality && { formality: Number(formality) }), ...(style && { style }), ...(notes.trim() && { notes: notes.trim() }),
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <LocationPicker value={place} onChange={onPlace} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Fecha" type="date" value={date} onChange={(e) => onDate(e.target.value)} required />
          <Input label="Hora (opcional)" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>

      <div className="space-y-3">
        <Input label="¿Qué ocasión es?" value={occasion} onChange={(e) => setOccasion(e.target.value)} placeholder="Describe el plan con tus palabras" required minLength={2} />
        <div className="flex flex-wrap gap-2" aria-label="Ejemplos de ocasión">
          {OCCASION_EXAMPLES.map((o) => (
            <button key={o} type="button" onClick={() => setOccasion(o)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", occasion === o ? "border-ink bg-ink text-paper" : "border-stone/70 hover:bg-linen")}>{o}</button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Actividad (opcional)" value={activity} onChange={(e) => setActivity(e.target.value)} />
        <Select label="Formalidad (opcional)" value={formality} onChange={(e) => setFormality(e.target.value)}>
          <option value="">La decide el estilista</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {["muy informal", "informal", "intermedia", "formal", "muy formal"][n - 1]}</option>)}
        </Select>
        <Select label="Estilo deseado (opcional)" value={style} onChange={(e) => setStyle(e.target.value)}>
          <option value="">Cualquiera</option>
          {STYLES.map((s) => <option key={s.value} value={s.label}>{s.label}</option>)}
        </Select>
      </div>
      <Textarea label="Algo más (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />

      <Button type="submit" size="lg" loading={loading} disabled={!place || occasion.trim().length < 2 || !date}>
        <Sparkles className="size-4" aria-hidden />Proponer conjuntos
      </Button>
      {!place && <p className="text-sm text-taupe">Elige un lugar para consultar el clima y ajustar los conjuntos.</p>}
    </form>
  );
}
