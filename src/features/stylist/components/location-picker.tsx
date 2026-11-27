"use client";
import { useEffect, useState } from "react";
import { LocateFixed, MapPin, X } from "lucide-react";
import { Button, Input, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import type { CityDTO, PlaceDTO } from "../types";

const label = (c: CityDTO) => [c.name, c.region, c.country].filter(Boolean).join(", ");

export function LocationPicker({ value, onChange }: { value: PlaceDTO | null; onChange: (p: PlaceDTO | null) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CityDTO[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const shown = q.trim().length >= 2 ? results : []; // derivado: no se resetea dentro del efecto

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try { setResults((await api<{ cities: CityDTO[] }>(`/api/geocode?q=${encodeURIComponent(q.trim())}`)).cities); }
      catch { setResults([]); }
      finally { setSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  function locate() {
    if (!("geolocation" in navigator)) return toast.error("Tu navegador no admite geolocalización");
    setLocating(true);
    // Solo se pide al pulsar el botón; el navegador muestra su propio permiso.
    navigator.geolocation.getCurrentPosition(
      (pos) => { onChange({ name: "Mi ubicación", latitude: pos.coords.latitude, longitude: pos.coords.longitude }); setLocating(false); },
      () => { toast.error("No se pudo obtener tu ubicación. Busca una ciudad."); setLocating(false); },
      { timeout: 10_000, maximumAge: 600_000 },
    );
  }

  if (value) {
    return (
      <div className="space-y-1.5">
        <span className="block text-sm font-medium">Lugar</span>
        <div className="flex h-11 items-center justify-between rounded-field border border-control bg-paper px-4">
          <span className="flex items-center gap-2 text-[0.95rem]"><MapPin className="size-4" aria-hidden />{value.name}</span>
          <button type="button" aria-label="Cambiar lugar" onClick={() => { onChange(null); setQ(""); }} className="rounded-full p-1 hover:bg-linen"><X className="size-4" /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Input label="Lugar" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Busca una ciudad" autoComplete="off" hint={searching ? "Buscando…" : undefined} />
      {shown.length > 0 && (
        /* `overflow-hidden` (esquinas redondeadas) recortaría el contorno global de foco (`outline-offset: 2px`, fuera de la caja): en estos botones, que llenan la lista,
            se dibuja hacia DENTRO (`-outline-offset-2`). Lleva `!` porque `:focus-visible` de `globals.css` no está en ninguna capa y gana a las utilidades. */
        <ul className="overflow-hidden rounded-field border border-control bg-paper">
          {shown.map((c) => (
            <li key={`${c.latitude},${c.longitude}`}>
              <button type="button" className="w-full px-4 py-2.5 text-left text-sm hover:bg-linen focus-visible:-outline-offset-2!" onClick={() => { onChange({ name: label(c), latitude: c.latitude, longitude: c.longitude }); setResults([]); }}>{label(c)}</button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={locate} loading={locating}><LocateFixed className="size-4" aria-hidden />Usar mi ubicación</Button>
    </div>
  );
}
