/**
 * Utilidades de foco para diálogos (solo DOM, sin React). Las usa la pila de modales (`modal-stack.ts`).
 *
 * «Tabulable» = lo que de verdad recibe el foco con Tab: se excluyen lo oculto (`hidden`, `display:none`, `visibility:hidden`), lo
 * deshabilitado (también por `<fieldset disabled>`), lo inerte (`inert` en el elemento o en un ancestro), `tabindex` negativo,
 * `input[type=hidden]` y los radios que no son parada de tabulación. Esto último corrige el defecto de la auditoría 22.4: el último
 * «enfocable» de «Añadir prendas» era un `<input type="file" class="hidden">`, el envoltorio del foco nunca se activaba y Tab salía
 * del diálogo.
 */

export const FOCUSABLE_SELECTOR = [
  "a[href]", "area[href]", "button", "input", "select", "textarea", "summary", "iframe",
  "audio[controls]", "video[controls]", '[contenteditable=""]', '[contenteditable="true"]', "[tabindex]",
].join(",");

/** ¿Está oculto el elemento? (`hidden`/`display:none` en él o en cualquier ancestro; `visibility` se hereda, basta su valor calculado). */
export function isHidden(el: Element, cache?: Map<Element, boolean>): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    // `cache` memoriza «¿es display:none o hidden?» por elemento: los ancestros se comparten entre muchos candidatos y getComputedStyle es caro.
    let none = cache?.get(n);
    if (none === undefined) {
      none = n.hasAttribute("hidden") || view.getComputedStyle(n).display === "none";
      cache?.set(n, none);
    }
    if (none) return true;
  }
  const visibility = view.getComputedStyle(el).visibility;
  return visibility === "hidden" || visibility === "collapse";
}

/** ¿Podría recibir foco con Tab (sin tener en cuenta el orden entre radios de un mismo grupo)? */
export function isTabbable(el: HTMLElement, cache?: Map<Element, boolean>): boolean {
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) < 0) return false;
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  if (el.matches(":disabled")) return false;
  if (el.closest("[inert]")) return false;
  return !isHidden(el, cache);
}

/**
 * Elementos tabulables dentro de `root`, en orden de documento. Entre los radios de un mismo grupo (mismo `name` y formulario) solo
 * cuenta el marcado o, si ninguno lo está, el primero: así se comporta Tab en los navegadores.
 */
export function getTabbables(root: HTMLElement): HTMLElement[] {
  const cache = new Map<Element, boolean>();
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => isTabbable(el, cache));
  const groupKey = (r: HTMLInputElement) => `${r.form ? "f" : ""}${r.name}`;
  const checked = new Set<string>();
  for (const el of all) if (el instanceof HTMLInputElement && el.type === "radio" && el.name && el.checked) checked.add(groupKey(el));
  const seen = new Set<string>();
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    const key = groupKey(el);
    if (checked.has(key)) return el.checked;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Siguiente destino de Tab (o Shift+Tab) con envoltura circular. Si el foco no está en la lista (p. ej. en el propio panel), entra por un extremo. */
export function nextTabTarget<T>(items: readonly T[], active: unknown, shift: boolean): T | undefined {
  if (items.length === 0) return undefined;
  const i = items.indexOf(active as T);
  if (i === -1) return shift ? items[items.length - 1] : items[0];
  return items[(i + (shift ? -1 : 1) + items.length) % items.length];
}

/**
 * Mueve el foco al siguiente tabulable (o anterior, con `shift`) COMPROBANDO que llega: si un candidato supera el filtro pero el
 * navegador no le da el foco (contenido de un <details> cerrado, `content-visibility:hidden`…), prueba el siguiente. Como mucho una
 * vuelta completa (una llamada a `focus()` por candidato, sin esperas ni bucles). Devuelve el elemento que recibió el foco o `null` si
 * ninguno lo aceptó (el llamador decide el destino de reserva). Si el foco vuelve al propio elemento activo, cuenta como recibido.
 */
export function focusNextTabbable(items: readonly HTMLElement[], active: unknown, shift: boolean): HTMLElement | null {
  let current: unknown = active;
  for (let attempts = 0; attempts < items.length; attempts++) {
    const candidate = nextTabTarget(items, current, shift);
    if (!candidate) return null;
    candidate.focus();
    if (candidate.ownerDocument.activeElement === candidate) return candidate;
    current = candidate; // rechazó el foco: el siguiente intento parte de él, en el mismo sentido
  }
  return null;
}

/** ¿Se puede devolver el foco a este elemento? Sigue en el documento, visible, habilitado y no inerte. */
export function isFocusRestorable(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  const doc = el.ownerDocument;
  if (el === doc.body || el === doc.documentElement) return false;
  return !isHidden(el) && !el.closest("[inert]") && !el.matches(":disabled");
}

/** Reserva segura cuando el elemento que abrió el diálogo ya no existe: la región principal de la página (<main>), hecha enfocable solo mientras la ocupa el foco. */
export function focusMainRegion(doc: Document = document): boolean {
  const main = doc.querySelector<HTMLElement>("main, [role='main']");
  if (!main) return false;
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
  }
  main.focus({ preventScroll: true });
  return doc.activeElement === main;
}
