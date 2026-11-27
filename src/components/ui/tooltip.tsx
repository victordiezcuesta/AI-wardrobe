"use client";
import { cloneElement, isValidElement, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";

/**
 * Tooltip accesible (WCAG 1.4.13): se muestra con ratón o foco, se descarta con Escape sin mover el foco, y el puntero puede pasar al propio tooltip
 * sin que se cierre (la caja exterior lo pega al disparador con un relleno inferior, sin hueco, y no tiene `pointer-events-none`).
 *
 * Descripción: `aria-describedby` se pone en el ELEMENTO ENFOCABLE (el hijo), no en el contenedor: es el que recibe el foco y el que anuncia el lector.
 * Con un único hijo elemento se le añade (conservando sus props, eventos y `ref`, y concatenando con un `aria-describedby` propio); con otro tipo de hijo
 * (texto, varios) se recurre al contenedor.
 *
 * Escape: se escucha en la fase de CAPTURA y se cancela (`preventDefault`), así que con un tooltip abierto dentro de un diálogo el primer Escape solo
 * descarta el tooltip (el diálogo ignora los eventos ya cancelados) y el segundo cierra el diálogo. Escape lo oculta hasta volver a entrar o enfocar.
 */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setOpen(false); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const single = isValidElement(children) ? (children as ReactElement<{ "aria-describedby"?: string }>) : null;
  const own = single?.props["aria-describedby"];
  const describedBy = open ? [own, id].filter(Boolean).join(" ") : own;
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={single ? undefined : open ? id : undefined}
    >
      {single ? cloneElement(single, { "aria-describedby": describedBy || undefined }) : children}
      {open && (
        <span className="absolute bottom-full left-1/2 z-50 -translate-x-1/2 pb-1.5">
          <span id={id} role="tooltip" className="block whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-xs text-paper">{text}</span>
        </span>
      )}
    </span>
  );
}
