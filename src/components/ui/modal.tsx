"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { registerModal } from "@/utils/modal-stack";

interface ModalProps { open: boolean; onClose: () => void; title: string; children: ReactNode }

/**
 * Modal propio. Cierra con Escape o con el fondo; la gestión de foco, Escape/Tab, bloqueo de scroll y aislamiento del fondo
 * (`inert`) es COMPARTIDA y vive en `utils/modal-stack.ts`: solo el diálogo superior de la pila responde, el foco vuelve a quien lo
 * abrió y el scroll sigue bloqueado mientras quede alguno abierto. Este componente solo se registra al abrirse y se da de baja al
 * cerrarse o desmontarse.
 */
export function Modal({ open, onClose, title, children }: ModalProps) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // `onClose` suele ser una función en línea que cambia en cada render del padre: se guarda en un ref para que el registro (y con él
  // el foco) dependa solo de `open` y no se reinicie por un cambio de identidad irrelevante.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const r = root.current;
    const p = panel.current;
    if (!open || !r || !p) return;
    return registerModal({ root: r, panel: p, close: () => closeRef.current() });
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div ref={root} className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-paper p-6 shadow-soft focus:outline-none sm:rounded-3xl"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <h2 id={titleId} className="font-display text-3xl leading-tight">{title}</h2>
              <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-full p-2 hover:bg-linen"><X className="size-5" /></button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
