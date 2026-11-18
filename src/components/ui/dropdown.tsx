"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface DropdownItem { label: string; onSelect: () => void; icon?: ReactNode; danger?: boolean }

export function Dropdown({ trigger, items, label }: { trigger: ReactNode; items: DropdownItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const nodes = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); nodes[(i + 1) % nodes.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); nodes[(i - 1 + nodes.length) % nodes.length]?.focus(); }
  };

  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div id={menuId} role="menu" onKeyDown={onMenuKey} className="absolute right-0 z-40 mt-2 min-w-48 rounded-2xl bg-paper p-1.5 shadow-soft ring-1 ring-stone/40">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={() => { setOpen(false); it.onSelect(); }}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-linen ${it.danger ? "text-danger" : ""}`}
            >
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
