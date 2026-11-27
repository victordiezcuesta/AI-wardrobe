import { focusMainRegion, focusNextTabbable, getTabbables, isFocusRestorable } from "./focus";
import { lockScroll } from "./scroll-lock";

/**
 * Pila de diálogos modales abiertos. Una ÚNICA pila y un único par de listeners en `document` (keydown y focusin) para toda la
 * aplicación; solo el diálogo SUPERIOR gestiona Escape y Tab. Antes cada `Modal` instalaba sus propios listeners: con diálogos
 * anidados ambos actuaban a la vez (Escape cerraba los dos; Tab saltaba entre ellos).
 *
 * Aislamiento del fondo SIN portal: al cambiar la pila se marca `inert` en los HERMANOS de cada ancestro de la raíz del diálogo
 * superior, hasta `<body>`. Así queda inerte (ni foco, ni clics, ni lectores de pantalla) todo lo que no es el propio diálogo, tanto
 * si el diálogo interior está dentro del panel del exterior (item-editor) como si son hermanos (history). Nunca se marca la raíz ni
 * sus ancestros (no se inutiliza el diálogo) y, al partir de la raíz, su fondo (hijo de ella) sigue admitiendo clic para cerrar. Las
 * regiones vivas (avisos `role="status"`, `aria-live`) no se marcan para no silenciar los toasts.
 *
 * Acompañantes (`[data-dialog-companion]`, hoy la región de avisos): sus controles tabulables se añaden al final del ciclo de Tab del diálogo
 * superior (y Shift+Tab desde el primero del diálogo llega al último acompañante), y `focusin` en ellos no devuelve el foco al diálogo. Así un aviso
 * emitido con el diálogo abierto se puede cerrar con el teclado SIN sacar el foco del ciclo ni romper el aislamiento (el resto del fondo sigue inerte).
 */
export interface ModalHandle {
  /** Elemento más externo del diálogo (fondo + panel). Punto de partida del aislamiento. */
  root: HTMLElement;
  /** Panel con `role="dialog"`: contiene lo tabulable y recibe el foco si no hay nada más. */
  panel: HTMLElement;
  /** Cierra el diálogo (la prop `onClose` más reciente). */
  close: () => void;
}

interface Entry extends ModalHandle {
  /** Elemento que tenía el foco al abrir (destino preferido al cerrar). */
  previous: HTMLElement | null;
  /** Destinos heredados de diálogos inferiores que se cerraron antes que este (para no perder el elemento que abrió el primero). */
  inherited: HTMLElement[];
  unlockScroll: () => void;
}

const stack: Entry[] = [];
/** Raíces de diálogos ya cerrados que siguen en el DOM por su animación de salida: permanecen `inert` hasta desmontarse (el aislamiento nunca las libera). */
const closing = new WeakSet<Element>();
let isolated: { el: Element; had: boolean }[] = [];
let listening = false;

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"]);
const LIVE_REGION = '[aria-live],[role="status"],[role="alert"]';

function releaseIsolation() {
  for (const { el, had } of isolated) if (!had && !closing.has(el)) el.removeAttribute("inert");
  isolated = [];
}

function applyIsolation() {
  releaseIsolation();
  const top = stack[stack.length - 1];
  if (!top) return;
  let node: Element = top.root;
  while (node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || SKIP_TAGS.has(sibling.tagName) || sibling.matches(LIVE_REGION)) continue;
      isolated.push({ el: sibling, had: sibling.hasAttribute("inert") });
      sibling.setAttribute("inert", "");
    }
    if (parent === document.body) break;
    node = parent;
  }
}

/** Selector de las regiones que acompañan al diálogo: fuera de él pero dentro de su ciclo de foco. */
const COMPANION = "[data-dialog-companion]";
const companions = () => Array.from(document.querySelectorAll<HTMLElement>(COMPANION));
const inCompanion = (n: Node) => companions().some((c) => c.contains(n));

function focusFirst(entry: Entry) {
  (getTabbables(entry.panel)[0] ?? entry.panel).focus();
}

function onKeyDown(e: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (!top || e.defaultPrevented || e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    top.close();
    return;
  }
  if (e.key !== "Tab") return;
  e.preventDefault(); // el recorrido se gestiona aquí, con la lista de tabulables reales
  const items = [...getTabbables(top.panel), ...companions().flatMap((c) => getTabbables(c))];
  // Si ningún candidato acepta el foco (o no hay tabulables), el foco se queda en el panel: nunca escapa al fondo.
  if (!focusNextTabbable(items, document.activeElement, e.shiftKey)) top.panel.focus();
}

/** Si el foco acaba fuera del diálogo superior (clic, foco programático…), vuelve a entrar. */
function onFocusIn(e: FocusEvent) {
  const top = stack[stack.length - 1];
  if (!top || !(e.target instanceof Node) || top.panel.contains(e.target) || inCompanion(e.target)) return;
  focusFirst(top);
}

function ensureListeners() {
  if (listening) return;
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  listening = true;
}

function dropListeners() {
  if (!listening) return;
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("focusin", onFocusIn);
  listening = false;
}

function restoreFocus(candidates: HTMLElement[], top: Entry | undefined) {
  for (const c of candidates) {
    if (!isFocusRestorable(c) || (top && !top.panel.contains(c))) continue;
    c.focus();
    if (document.activeElement === c) return;
  }
  if (top) {
    if (top.panel.isConnected) focusFirst(top); // el elemento que abrió el interior ya no está: volver al diálogo exterior
    return;
  }
  focusMainRegion(); // reserva segura: la región principal de la página
}

function unregister(entry: Entry) {
  const i = stack.indexOf(entry);
  if (i === -1) return;
  const wasTop = i === stack.length - 1;
  stack.splice(i, 1);
  entry.unlockScroll();
  // Mientras dura la animación de salida, el diálogo ya cerrado (cuyo contenido sigue en el DOM) no debe recibir foco ni clics.
  closing.add(entry.root);
  entry.root.setAttribute("inert", "");
  if (stack.length === 0) dropListeners();
  applyIsolation(); // antes de devolver el foco: un elemento inerte no puede recibirlo
  const candidates = [entry.previous, ...entry.inherited].filter((c): c is HTMLElement => !!c);
  if (!wasTop) {
    stack[i]?.inherited.push(...candidates); // se cerró uno inferior: su destino pasa al que tiene encima
    return;
  }
  restoreFocus(candidates, stack[stack.length - 1]);
}

/** Registra un diálogo abierto y devuelve la función que lo da de baja (idempotente). Úsala desde un efecto de React. */
export function registerModal(handle: ModalHandle): () => void {
  const active = document.activeElement;
  const entry: Entry = {
    ...handle,
    previous: active instanceof HTMLElement && active !== document.body ? active : null,
    inherited: [],
    unlockScroll: lockScroll(),
  };
  closing.delete(handle.root);
  handle.root.removeAttribute("inert"); // la misma raíz puede reutilizarse tras una salida anterior (p. ej. Strict Mode)
  const above = stack.findIndex((e) => handle.root.contains(e.root)); // si contiene a otros ya abiertos, queda DEBAJO de ellos
  if (above === -1) stack.push(entry);
  else stack.splice(above, 0, entry);
  ensureListeners();
  applyIsolation();
  if (stack[stack.length - 1] === entry && !entry.panel.contains(document.activeElement)) focusFirst(entry);
  return () => unregister(entry);
}

/** Número de diálogos abiertos (para diagnóstico y pruebas). */
export const openModalCount = () => stack.length;
