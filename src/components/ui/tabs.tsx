"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/utils/cn";

export interface TabItem<K extends string = string> { key: K; label: string }

/**
 * Pestaña a la que lleva cada tecla (patrón de pestañas de WAI-ARIA APG, orientación horizontal), o `null` si la tecla NO es del
 * componente. Las flechas dan la vuelta en los extremos (de la última a la primera y viceversa); Inicio y Fin van a la primera y la última.
 * Arriba/abajo, RePág/AvPág, Enter, espacio… no son de las pestañas y no se interceptan.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight": return (current + 1) % count;
    case "ArrowLeft": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/**
 * Pestañas accesibles (WAI-ARIA APG, activación AUTOMÁTICA: los paneles cambian al instante, sin carga, así que las flechas seleccionan y
 * mueven el foco a la vez). `tablist` con nombre, `tab` con `aria-selected`, `aria-controls` y roving `tabindex` (solo la seleccionada es
 * tabulable: Tab sale del `tablist` hacia el panel), y un `tabpanel` por pestaña con `aria-labelledby`. La selección NO cambia al recibir
 * foco, solo con flechas, Inicio/Fin o un clic. Cada panel existe siempre en el DOM (para que `aria-controls` apunte a algo real) y solo
 * el activo se muestra; el resto queda `hidden`. Por defecto el contenido de los paneles inactivos NO se monta (vacíos); con `keepMounted`
 * todos montan su contenido y los inactivos solo se ocultan, así que conservan su estado (lo escrito en un formulario, etc.) al cambiar de
 * pestaña, también al explorarlas con las flechas. El contenido oculto no está en el árbol de accesibilidad ni en el orden de Tab. Los
 * paneles de este proyecto contienen controles enfocables, así que no llevan `tabindex`.
 */
export function Tabs<K extends string>({ label, tabs, value, onChange, panels, keepMounted = false }: {
  label: string;
  tabs: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Contenido de cada pestaña, por clave. */
  panels: Record<K, ReactNode>;
  /** `true`: el contenido de todos los paneles permanece montado (los inactivos, ocultos) y conserva su estado. Por defecto, solo el activo. */
  keepMounted?: boolean;
}) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabId = (k: K) => `${base}-tab-${k}`;
  const panelId = (k: K) => `${base}-panel-${k}`;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;   // combinaciones del navegador o del sistema: no son nuestras
    const next = nextTabIndex(e.key, index, tabs.length);
    if (next === null) return;
    e.preventDefault();                                               // solo las teclas que se gestionan (evita el desplazamiento de la página)
    onChange(tabs[next]!.key);
    refs.current[next]?.focus();                                      // el foco acompaña a la selección
  }

  return (
    <>
      <div role="tablist" aria-label={label} className="mb-5 flex gap-2">
        {tabs.map((t, i) => {
          const selected = t.key === value;
          return (
            <button
              key={t.key}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              id={tabId(t.key)}
              aria-selected={selected}
              aria-controls={panelId(t.key)}
              tabIndex={selected ? 0 : -1}
              onClick={(e) => {
                if (t.key === value) return;                       // ya activa: sin cambios ni saltos de foco
                onChange(t.key);
                e.currentTarget.focus();                           // Safari no enfoca un botón al hacer clic: así el foco no se pierde con el panel que se oculta
              }}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn("rounded-full px-4 py-1.5 text-sm", selected ? "bg-ink text-paper" : "bg-linen")}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" id={panelId(t.key)} aria-labelledby={tabId(t.key)} hidden={t.key !== value}>
          {keepMounted || t.key === value ? panels[t.key] : null}
        </div>
      ))}
    </>
  );
}
