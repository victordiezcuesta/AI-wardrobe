"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { focusMainRegion, isFocusRestorable } from "@/utils/focus";

type Kind = "success" | "error" | "info";
interface ToastItem { id: number; kind: Kind; message: string }
const Ctx = createContext<{ push: (kind: Kind, message: string) => void } | null>(null);

/** Máximo de avisos NO críticos (éxito/info) a la vez: al superarlo se retira el más antiguo de ellos. Los errores nunca se retiran solos. */
export const MAX_TRANSIENT_TOASTS = 3;

/**
 * Avisos. Un aviso NO desaparece solo (WCAG 2.2.1: no se pierde información por un límite de tiempo): permanece hasta que el usuario lo cierra
 * con su botón «Cerrar aviso» (ratón, teclado o lector de pantalla). No hay temporizadores.
 *
 * Acumulación: un aviso idéntico (mismo tipo y texto) a uno ya visible no se duplica; y de éxito/info solo se conservan los `MAX_TRANSIENT_TOASTS`
 * más recientes. Los errores no se retiran nunca por este límite (ni se pierden en silencio): se cierran a mano. En móvil la región se sitúa SOBRE
 * la barra de navegación inferior y, si crece, se desplaza (`max-h` + `overflow-y-auto`).
 *
 * Con un diálogo abierto, la región es «acompañante» del diálogo (`data-dialog-companion`, ver `modal-stack`): su botón entra en el ciclo de Tab del
 * diálogo, así que el aviso se puede cerrar con el teclado sin romper el aislamiento del fondo.
 *
 * Foco al cerrar o al ser expulsado por el límite (misma gestión, `releaseFocus`, ANTES de retirar el aviso): solo si el foco estaba DENTRO del aviso que se retira se mueve (para no dejarlo en un elemento eliminado): al aviso vecino si
 * queda alguno y, si no, al elemento donde estaba el foco antes de entrar en los avisos (si sigue siendo utilizable; sin desplazar la página) o,
 * en su defecto, a la región principal. Si el foco estaba fuera (o en ninguna parte), no se toca. La referencia al origen se descarta al salir.
 * `Enter` mantenido (`repeat`) no cierra avisos consecutivos. La región es `aria-atomic="false"` (`role=status` implica `true`): al añadir un
 * aviso se anuncia solo el nuevo. Se mantiene `polite`: los errores bloqueantes de los formularios ya usan `role="alert"` en línea.
 *
 * Desplazamiento: mientras hay avisos se publica su altura efectiva en `--toast-inset` (px, sobre `<html>`); `globals.css` la usa en
 * `scroll-padding-bottom` para que un elemento enfocado no quede tapado por la región fija.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Lista AUTORITATIVA y síncrona (el estado `items` la refleja). Permite decidir —y mover el foco— ANTES de retirar un aviso, sin efectos secundarios dentro de
  // un actualizador de `setItems` (que React puede ejecutar dos veces en StrictMode) y sin leer una lista desfasada si llegan varios avisos en el mismo evento.
  const list = useRef<ToastItem[]>([]);
  const nodes = useRef(new Map<number, HTMLElement>());
  const region = useRef<HTMLDivElement>(null);
  const lastOutside = useRef<Element | null>(null);   // dónde estaba el foco justo antes de entrar en la región de avisos
  const seq = useRef(0);

  const commit = useCallback((next: ToastItem[]) => { list.current = next; setItems(next); }, []);

  /**
   * Si el foco está dentro de alguno de los avisos que se van a RETIRAR (cierre manual o expulsión por el límite), lo mueve antes de retirarlos, para no dejarlo
   * en un elemento eliminado: al botón del aviso superviviente más cercano (primero los siguientes, luego los anteriores) y, si no queda ninguno con su nodo
   * montado, al elemento donde estaba el foco antes de entrar en los avisos (si sigue siendo utilizable; sin desplazar la página) o, en su defecto, a la
   * región principal. Si el foco estaba fuera de esos avisos, no lo toca.
   */
  const releaseFocus = useCallback((removed: ReadonlySet<number>) => {
    const active = document.activeElement;
    if (!active) return;
    const holder = list.current.find((t) => removed.has(t.id) && nodes.current.get(t.id)?.contains(active));
    if (!holder) return;
    const old = list.current;
    const i = old.indexOf(holder);
    const alive = (t: ToastItem) => !removed.has(t.id) && nodes.current.get(t.id)?.isConnected === true;
    const neighbor = old.slice(i + 1).find(alive) ?? old.slice(0, i).reverse().find(alive);
    const neighborButton = neighbor ? nodes.current.get(neighbor.id)?.querySelector("button") : null;
    neighborButton?.focus();
    if (neighborButton && document.activeElement === neighborButton) return;      // el vecino aceptó el foco
    const back = lastOutside.current;                                             // si no hay vecino (o lo rechazó): el origen, y si no, la región principal
    if (back instanceof HTMLElement && isFocusRestorable(back)) back.focus({ preventScroll: true });
    else focusMainRegion();
  }, []);

  const push = useCallback((kind: Kind, message: string) => {
    const cur = list.current;
    if (cur.some((t) => t.kind === kind && t.message === message)) return;   // idéntico a uno visible: no se duplica
    let next = [...cur, { id: ++seq.current, kind, message }];
    const transient = next.filter((t) => t.kind !== "error");
    if (kind !== "error" && transient.length > MAX_TRANSIENT_TOASTS) {
      const drop = new Set(transient.slice(0, transient.length - MAX_TRANSIENT_TOASTS).map((t) => t.id));
      releaseFocus(drop);                                                      // la expulsión también cuida el foco
      next = next.filter((t) => !drop.has(t.id));
    }
    commit(next);
  }, [commit, releaseFocus]);

  const dismiss = useCallback((id: number) => {
    if (!list.current.some((t) => t.id === id)) return;   // ya retirado (p. ej. doble clic durante la animación de salida): nada que hacer ni que restaurar
    releaseFocus(new Set([id]));
    commit(list.current.filter((t) => t.id !== id));
  }, [commit, releaseFocus]);

  function rememberOutside(e: FocusEvent<HTMLDivElement>) {
    const from = e.relatedTarget;
    if (from instanceof Node && e.currentTarget.contains(from)) return;   // el foco se mueve dentro de los avisos
    lastOutside.current = from instanceof Element ? from : null;
  }
  function forgetOutside(e: FocusEvent<HTMLDivElement>) {
    const to = e.relatedTarget;
    if (!(to instanceof Node && e.currentTarget.contains(to))) lastOutside.current = null;   // el foco sale de los avisos: no se retiene el origen
  }
  // Mantener Enter pulsado repite el `click` del botón; tras cerrar, el foco pasa al aviso vecino y cerraría también ese. El primer Enter sí cierra.
  function ignoreRepeat(e: KeyboardEvent<HTMLButtonElement>) { if (e.repeat && e.key === "Enter") e.preventDefault(); }

  // Altura efectiva de la región (incluye su distancia al borde: en móvil, la barra de navegación) para `scroll-padding` (H.6.1).
  useEffect(() => {
    const el = region.current;
    const root = document.documentElement;
    if (!el) return;
    const update = () => {
      if (list.current.length === 0) { root.style.removeProperty("--toast-inset"); return; }
      const top = el.getBoundingClientRect().top;
      root.style.setProperty("--toast-inset", `${Math.ceil(Math.max(0, window.innerHeight - top)) + 16}px`);
    };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener("resize", update);
    return () => { ro?.disconnect(); window.removeEventListener("resize", update); root.style.removeProperty("--toast-inset"); };
  }, [items]);

  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        ref={region}
        data-dialog-companion=""
        className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-[60] flex max-h-[50dvh] flex-col items-center gap-2 overflow-y-auto px-4 lg:bottom-4"
        role="status"
        aria-live="polite"
        aria-atomic="false"
        onFocusCapture={rememberOutside}
        onBlurCapture={forgetOutside}
      >
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              ref={(el: HTMLDivElement | null) => { if (el) nodes.current.set(t.id, el); else nodes.current.delete(t.id); }}
              layout
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ opacity: 0 }}
              className={cn("pointer-events-auto flex max-w-md shrink-0 items-center gap-2 rounded-full py-2 pl-5 pr-2 text-sm shadow-soft", t.kind === "error" ? "bg-danger text-paper" : "bg-ink text-paper")}
            >
              <span>{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                onKeyDown={ignoreRepeat}
                aria-label="Cerrar aviso"
                className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-paper/15 focus-visible:ring-2 focus-visible:ring-paper"
              >
                <X className="size-4" aria-hidden />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast requiere <ToastProvider>");
  return {
    success: (m: string) => ctx.push("success", m),
    error: (m: string) => ctx.push("error", m),
    info: (m: string) => ctx.push("info", m),
  };
}
