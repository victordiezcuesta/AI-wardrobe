"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ChipGroup, Input, Select, useToast } from "@/components/ui";
import { api, ApiError, NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { groupIssues } from "@/utils/issues";
import { LocationPicker } from "@/features/stylist/components/location-picker";
import type { PlaceDTO } from "@/features/stylist/types";
import { FIT_OPTIONS, GARMENT_TYPES, STYLES } from "../constants";

export interface ProfileFormValues {
  name: string;
  age: number | null;
  heightCm: number | null;
  presentation: string;
  usualStyles: string[];
  exploreStyles: string[];
  favoriteColors: string[];
  avoidedColors: string[];
  favoriteBrands: string[];
  budgetMin: number | null;
  budgetMax: number | null;
  sizes: { top?: string; bottom?: string; shoes?: string };
  fitPreference: string;
  favoriteGarments: string[];
  home: PlaceDTO | null;
}

/** Campos del formulario que muestran errores. Los elementos de las listas separadas por comas («favoriteColors.2») se atribuyen a su campo. */
const FIELD_NAMES = ["name", "age", "heightCm", "presentation", "fitPreference", "favoriteColors", "avoidedColors", "favoriteBrands", "sizes.top", "sizes.bottom", "sizes.shoes", "budgetMin", "budgetMax"] as const;
const LIST_FIELDS = new Set(["favoriteColors", "avoidedColors", "favoriteBrands"]);
const resolveField = (path: string) => { const m = /^(\w+)\.\d+$/.exec(path); return m && LIST_FIELDS.has(m[1]!) ? m[1] : path; };

const toList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const toNum = (s: string) => (s.trim() === "" ? null : Number(s));

export function ProfileForm({ initial, mode }: { initial: ProfileFormValues; mode: "onboarding" | "settings" }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState(initial);
  const [lists, setLists] = useState({
    favoriteColors: initial.favoriteColors.join(", "),
    avoidedColors: initial.avoidedColors.join(", "),
    favoriteBrands: initial.favoriteBrands.join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]); // validación del servidor sin campo que la represente (p. ej. la ciudad habitual)
  const set = <K extends keyof ProfileFormValues>(k: K, val: ProfileFormValues[K]) => setV((s) => ({ ...s, [k]: val }));

  async function save(skip = false) {
    setSaving(true);
    setErrors({});
    setFormErrors([]);
    const payload = skip
      ? { onboardingDone: true }
      : {
          ...v,
          name: v.name,
          presentation: v.presentation || null,
          fitPreference: v.fitPreference || null,
          favoriteColors: toList(lists.favoriteColors),
          avoidedColors: toList(lists.avoidedColors),
          favoriteBrands: toList(lists.favoriteBrands),
          homeCity: v.home?.name ?? null,
          homeLat: v.home?.latitude ?? null,
          homeLon: v.home?.longitude ?? null,
          onboardingDone: true,
        };
    try {
      await api("/api/profile", { method: "PUT", json: payload });
      if (mode === "onboarding") { router.push("/dashboard"); router.refresh(); }
      else { toast.success("Perfil guardado"); router.refresh(); }
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.issues?.length) {
        // Los errores de campo van a su campo. Los globales y los de un path que el formulario no representa (homeCity, homeLat,
        // homeLon, estilos…) NO se atribuyen a ningún campo: se muestran en un aviso general, sin repetir mensajes.
        const g = groupIssues(err.issues, { fields: FIELD_NAMES, resolve: resolveField });
        setErrors(g.fields);
        setFormErrors([...new Set([...g.global, ...g.unmatched.map((u) => u.message)])]);
      }
      toast.error(err instanceof ApiError ? err.message : err instanceof Error ? NETWORK_ERROR_MESSAGE : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-10">
      <section className="max-w-md space-y-2">
        <LocationPicker value={v.home} onChange={(p) => set("home", p)} />
        <p className="text-sm text-taupe">Tu ciudad habitual: la usamos para mostrarte el clima de hoy en el inicio. Es opcional.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Input label="Nombre" value={v.name} onChange={(e) => set("name", e.target.value)} autoComplete="given-name" error={errors.name} />
        <Input label="Edad" type="number" inputMode="numeric" value={v.age ?? ""} onChange={(e) => set("age", toNum(e.target.value))} error={errors.age} />
        <Input label="Altura (cm)" type="number" inputMode="numeric" value={v.heightCm ?? ""} onChange={(e) => set("heightCm", toNum(e.target.value))} error={errors.heightCm} />
        <Input label="Cómo prefieres presentar tu ropa" value={v.presentation} onChange={(e) => set("presentation", e.target.value)} hint="Femenina, masculina, neutra… como quieras." className="sm:col-span-2" error={errors.presentation} />
        <Select label="Ajuste preferido" value={v.fitPreference} onChange={(e) => set("fitPreference", e.target.value)} error={errors.fitPreference}>
          <option value="">Sin preferencia</option>
          {FIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </section>

      <section className="space-y-6">
        <ChipGroup label="Tu estilo habitual" options={STYLES} value={v.usualStyles} onChange={(x) => set("usualStyles", x)} />
        <ChipGroup label="Estilos que quieres explorar" options={STYLES} value={v.exploreStyles} onChange={(x) => set("exploreStyles", x)} />
        <ChipGroup label="Prendas que más te gustan" options={GARMENT_TYPES} value={v.favoriteGarments} onChange={(x) => set("favoriteGarments", x)} />
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Input label="Colores favoritos" value={lists.favoriteColors} onChange={(e) => setLists((s) => ({ ...s, favoriteColors: e.target.value }))} hint="Separados por comas: beige, negro, azul marino" error={errors.favoriteColors} />
        <Input label="Colores que no usas" value={lists.avoidedColors} onChange={(e) => setLists((s) => ({ ...s, avoidedColors: e.target.value }))} error={errors.avoidedColors} />
        <Input label="Marcas favoritas" value={lists.favoriteBrands} onChange={(e) => setLists((s) => ({ ...s, favoriteBrands: e.target.value }))} className="sm:col-span-2" error={errors.favoriteBrands} />
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Input label="Talla superior" value={v.sizes.top ?? ""} onChange={(e) => set("sizes", { ...v.sizes, top: e.target.value })} error={errors["sizes.top"]} />
        <Input label="Talla inferior" value={v.sizes.bottom ?? ""} onChange={(e) => set("sizes", { ...v.sizes, bottom: e.target.value })} error={errors["sizes.bottom"]} />
        <Input label="Número de calzado" value={v.sizes.shoes ?? ""} onChange={(e) => set("sizes", { ...v.sizes, shoes: e.target.value })} error={errors["sizes.shoes"]} />
        <Input label="Presupuesto por prenda, desde (€)" type="number" inputMode="numeric" value={v.budgetMin ?? ""} onChange={(e) => set("budgetMin", toNum(e.target.value))} error={errors.budgetMin} />
        <Input label="Presupuesto por prenda, hasta (€)" type="number" inputMode="numeric" value={v.budgetMax ?? ""} onChange={(e) => set("budgetMax", toNum(e.target.value))} error={errors.budgetMax} />
      </section>

      {formErrors.length > 0 && (
        <div role="alert" className="max-w-xl space-y-1 rounded-card bg-linen p-4 text-sm text-danger">
          <p className="font-medium">No se han podido guardar estos datos:</p>
          <ul className="list-disc space-y-0.5 pl-5">{formErrors.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" loading={saving}>{mode === "onboarding" ? "Guardar y entrar" : "Guardar cambios"}</Button>
        {mode === "onboarding" && <Button type="button" variant="ghost" size="lg" onClick={() => void save(true)} disabled={saving}>Rellenar más tarde</Button>}
      </div>
    </form>
  );
}
