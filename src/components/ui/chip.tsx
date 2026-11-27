"use client";
import { cn } from "@/utils/cn";

interface ChipGroupProps<T extends string> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T[];
  onChange: (next: T[]) => void;
}

/** Selección múltiple accesible (botones con aria-pressed). */
export function ChipGroup<T extends string>({ label, options, value, onChange }: ChipGroupProps<T>) {
  const toggle = (v: T) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.value)}
              className={cn(
                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                on ? "border-ink bg-ink text-paper" : "border-control bg-paper hover:bg-linen",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
