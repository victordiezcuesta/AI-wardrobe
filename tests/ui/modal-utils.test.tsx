import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { focusMainRegion, focusNextTabbable, getTabbables, isFocusRestorable, isTabbable, nextTabTarget } from "@/utils/focus";
import { activeScrollLocks, lockScroll } from "@/utils/scroll-lock";
import { openModalCount, registerModal } from "@/utils/modal-stack";

/**
 * Fase C — utilidades de foco, bloqueo de scroll y pila de modales, sobre DOM real de jsdom (proyecto `dom`). jsdom calcula
 * `getComputedStyle` a partir de las hojas de estilo, pero NO implementa `inert` (no impide foco ni clics): aquí se comprueban los
 * atributos `inert` y la lógica propia de foco; que un navegador real bloquee el foco y los clics en lo inerte no está demostrado por
 * estas pruebas (se verifica aparte con Chrome).
 */
const labelOf = (el: Element | null) => el?.getAttribute("aria-label") ?? el?.textContent ?? el?.tagName;
const html = (s: string) => { document.body.innerHTML = s; };
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

afterEach(() => { document.body.innerHTML = ""; document.body.removeAttribute("style"); document.head.querySelectorAll("style[data-test]").forEach((s) => s.remove()); });

describe("getTabbables / isTabbable — qué recibe foco de verdad", () => {
  it("incluye controles normales y elementos con tabindex >= 0 y contenteditable, en orden de documento", () => {
    html(`<div id="r"><a href="#a" aria-label="enlace">e</a><button aria-label="b1">b</button><input aria-label="i1"><select aria-label="s1"></select><textarea aria-label="t1"></textarea><div tabindex="0" aria-label="d0"></div><div contenteditable="true" aria-label="ce"></div></div>`);
    expect(getTabbables($("#r")).map(labelOf)).toEqual(["enlace", "b1", "i1", "s1", "t1", "d0", "ce"]);
  });

  it("excluye deshabilitados (también por <fieldset disabled>), tabindex negativo y enlaces sin href", () => {
    html(`<div id="r"><button disabled aria-label="x1"></button><fieldset disabled><button aria-label="x2"></button></fieldset><div tabindex="-1" aria-label="x3"></div><a aria-label="x4">sin href</a><button aria-label="ok"></button></div>`);
    expect(getTabbables($("#r")).map(labelOf)).toEqual(["ok"]);
  });

  it("excluye input[type=hidden] y lo oculto por atributo hidden, display:none y visibility:hidden (también heredado de un ancestro)", () => {
    html(`<div id="r"><input type="hidden" aria-label="x1"><button hidden aria-label="x2"></button><button style="display:none" aria-label="x3"></button><div hidden><button aria-label="x4"></button></div><div style="display:none"><button aria-label="x5"></button></div><div style="visibility:hidden"><button aria-label="x6"></button></div><button aria-label="ok"></button></div>`);
    expect(getTabbables($("#r")).map(labelOf)).toEqual(["ok"]);
  });

  it("excluye el input de archivo oculto por una clase CSS (el caso de «Añadir prendas»), pero no uno visible", () => {
    const st = document.createElement("style"); st.dataset.test = "1"; st.textContent = ".hidden{display:none}"; document.head.appendChild(st);
    html(`<div id="r"><button aria-label="elegir"></button><input type="file" class="hidden" aria-label="oculto-1"><input type="file" multiple class="hidden" aria-label="oculto-2"><input type="file" aria-label="visible"></div>`);
    expect(getTabbables($("#r")).map(labelOf)).toEqual(["elegir", "visible"]);
  });

  it("excluye lo que está dentro de un ancestro inerte", () => {
    html(`<div id="r"><div inert><button aria-label="x1"></button></div><button aria-label="ok"></button></div>`);
    expect(getTabbables($("#r")).map(labelOf)).toEqual(["ok"]);
    expect(isTabbable($("[aria-label=x1]"))).toBe(false);
  });

  it("radios: solo el marcado es parada de tabulación; sin ninguno marcado, el primero; sin name, todos", () => {
    html(`<div id="r"><input type="radio" name="g" aria-label="g1"><input type="radio" name="g" aria-label="g2" checked><input type="radio" name="g" aria-label="g3"><input type="radio" name="h" aria-label="h1"><input type="radio" name="h" aria-label="h2"><input type="radio" aria-label="n1"><input type="radio" aria-label="n2"></div>`);
    expect(getTabbables($("#r")).map(labelOf)).toEqual(["g2", "h1", "n1", "n2"]);
  });
});

describe("nextTabTarget", () => {
  const items = ["a", "b", "c"];
  it("avanza y retrocede con envoltura circular", () => {
    expect(nextTabTarget(items, "a", false)).toBe("b");
    expect(nextTabTarget(items, "c", false)).toBe("a");
    expect(nextTabTarget(items, "a", true)).toBe("c");
    expect(nextTabTarget(items, "b", true)).toBe("a");
  });
  it("si el foco no está en la lista entra por un extremo (Tab → primero, Shift+Tab → último); con un solo elemento se queda en él", () => {
    expect(nextTabTarget(items, "zzz", false)).toBe("a");
    expect(nextTabTarget(items, null, true)).toBe("c");
    expect(nextTabTarget(["x"], "x", false)).toBe("x");
    expect(nextTabTarget(["x"], "x", true)).toBe("x");
  });
  it("sin elementos no hay destino", () => { expect(nextTabTarget([], "a", false)).toBeUndefined(); });
});

describe("isFocusRestorable", () => {
  it("acepta un botón visible y habilitado y rechaza null, desconectados, body, ocultos, deshabilitados e inertes", () => {
    html(`<div><button id="ok">ok</button><button id="dis" disabled>d</button><button id="hid" hidden>h</button><div inert><button id="ine">i</button></div></div>`);
    expect(isFocusRestorable($("#ok"))).toBe(true);
    for (const id of ["#dis", "#hid", "#ine"]) expect(isFocusRestorable($(id))).toBe(false);
    expect(isFocusRestorable(null)).toBe(false);
    expect(isFocusRestorable(document.createElement("button"))).toBe(false); // sin conectar
    expect(isFocusRestorable(document.body)).toBe(false);
  });
});

describe("focusMainRegion — reserva segura de foco", () => {
  it("enfoca <main> haciéndolo enfocable solo mientras lo ocupa el foco", () => {
    html(`<main id="m">contenido</main>`);
    expect(focusMainRegion()).toBe(true);
    expect($("#m")).toHaveFocus();
    expect($("#m")).toHaveAttribute("tabindex", "-1");
    $("#m").blur();
    expect($("#m")).not.toHaveAttribute("tabindex");
  });
  it("respeta un tabindex que ya tuviera y devuelve false si no hay región principal", () => {
    html(`<main id="m" tabindex="0">x</main>`);
    focusMainRegion(); $("#m").blur();
    expect($("#m")).toHaveAttribute("tabindex", "0");
    html(`<div>sin main</div>`);
    expect(focusMainRegion()).toBe(false);
  });
});

describe("bloqueo de scroll con contador", () => {
  beforeEach(() => { document.body.style.overflow = ""; });
  it("bloquea con el primero y restaura el valor original solo al soltar el último", () => {
    document.body.style.overflow = "scroll"; // valor original del documento
    const a = lockScroll(); expect(document.body.style.overflow).toBe("hidden");
    const b = lockScroll(); expect(activeScrollLocks()).toBe(2);
    b(); expect(document.body.style.overflow).toBe("hidden"); // queda uno
    a(); expect(document.body.style.overflow).toBe("scroll"); expect(activeScrollLocks()).toBe(0);
  });
  it("soltar dos veces el mismo bloqueo no desequilibra el contador ni libera el de otro", () => {
    const a = lockScroll(); const b = lockScroll();
    a(); a(); a();
    expect(activeScrollLocks()).toBe(1);
    expect(document.body.style.overflow).toBe("hidden");
    b(); expect(activeScrollLocks()).toBe(0); expect(document.body.style.overflow).toBe("");
  });
});

/** Construye un diálogo de verdad en el DOM: raíz > (fondo, panel con tabindex -1). */
function build(parent: HTMLElement, id: string, inner = "") {
  const root = document.createElement("div"); root.id = `${id}-root`;
  root.innerHTML = `<div id="${id}-backdrop"></div><div id="${id}-panel" role="dialog" tabindex="-1" aria-label="${id}">${inner}</div>`;
  parent.appendChild(root);
  return { root, panel: root.querySelector<HTMLElement>(`#${id}-panel`)!, close: vi.fn() };
}

describe("registerModal — pila, foco y aislamiento (DOM real)", () => {
  it("al registrar mueve el foco al primer tabulable; sin tabulables, al propio panel, y Tab/Shift+Tab no lo dejan salir", async () => {
    html(`<main><button id="opener">abrir</button><button id="fuera">fuera</button></main><div id="host"></div>`);
    const user = userEvent.setup();
    const d = build($("#host"), "d", `<span>solo texto</span>`);
    $("#opener").focus();
    const off = registerModal(d);
    expect(d.panel).toHaveFocus();
    await user.tab(); expect(d.panel).toHaveFocus();
    await user.tab({ shift: true }); expect(d.panel).toHaveFocus();
    $("#fuera").focus(); // foco programático al fondo: el listener de focusin lo devuelve al diálogo
    expect(d.panel).toHaveFocus();
    off();
    expect($("#opener")).toHaveFocus();
  });

  it("el diálogo registrado más reciente (o el que queda dentro de otro) es el único que responde a Escape y a Tab", async () => {
    html(`<main id="app"><button id="opener">abrir</button><div id="host"></div></main>`);
    const user = userEvent.setup();
    const outer = build($("#host"), "o", `<button aria-label="o1"></button><div id="slot"></div><button aria-label="o2"></button>`);
    const offO = registerModal(outer);
    const inner = build($("#slot"), "i", `<button aria-label="i1"></button><button aria-label="i2"></button>`);
    const offI = registerModal(inner);
    expect(openModalCount()).toBe(2);
    await user.keyboard("{Escape}");
    expect(inner.close).toHaveBeenCalledTimes(1);
    expect(outer.close).not.toHaveBeenCalled();
    // Tab solo recorre el interior
    const seen: string[] = []; for (let i = 0; i < 5; i++) { await user.tab(); seen.push(labelOf(document.activeElement)!); }
    expect(new Set(seen)).toEqual(new Set(["i1", "i2"]));
    offI(); offO();
  });

  it("si el diálogo exterior se registra DESPUÉS (efectos en orden hijo→padre), queda por debajo del que contiene", async () => {
    html(`<div id="host"></div>`);
    const user = userEvent.setup();
    const outer = build($("#host"), "o", `<button aria-label="o1"></button><div id="slot"></div>`);
    const inner = build(outer.panel.querySelector<HTMLElement>("#slot")!, "i", `<button aria-label="i1"></button>`);
    const offI = registerModal(inner); // primero el interior…
    const offO = registerModal(outer); // …y después el exterior (contiene al interior)
    await user.keyboard("{Escape}");
    expect(inner.close).toHaveBeenCalledTimes(1);
    expect(outer.close).not.toHaveBeenCalled();
    offO(); offI();
  });

  it("aísla el fondo: inert en los hermanos del camino hasta <body>, nunca en la raíz ni en sus ancestros; respeta avisos y un inert previo", () => {
    html(`<div id="app"><main id="page"><button id="b">fondo</button></main><aside id="side"></aside><div id="live" role="status"></div><div id="ya" inert></div><div id="host"></div></div><footer id="foot"></footer>`);
    const outer = build($("#host"), "o", `<header id="o-head"><button aria-label="h"></button></header><div id="slot"></div>`);
    const offO = registerModal(outer);
    const isInert = (sel: string) => $(sel).hasAttribute("inert");
    for (const s of ["#page", "#side", "#foot"]) expect(isInert(s)).toBe(true);
    expect(isInert("#live")).toBe(false);                 // región viva: no se silencia
    for (const s of ["#app", "#host", "#o-root", "#o-panel", "#o-backdrop"]) expect(isInert(s)).toBe(false); // ancestros, raíz y su fondo
    const inner = build($("#slot"), "i", `<button aria-label="i1"></button>`);
    const offI = registerModal(inner);
    expect(isInert("#o-head")).toBe(true);                // el contenido del exterior queda inerte mientras haya un interior
    expect(isInert("#o-backdrop")).toBe(true);
    for (const s of ["#i-root", "#i-panel", "#i-backdrop", "#o-root", "#o-panel", "#slot"]) expect(isInert(s)).toBe(false);
    offI();
    expect(isInert("#o-head")).toBe(false);               // al cerrar el interior, el exterior vuelve a estar activo
    expect(isInert("#page")).toBe(true);                  // y el fondo sigue aislado
    offO();
    for (const s of ["#page", "#side", "#foot", "#o-head"]) expect(isInert(s)).toBe(false);
    expect(isInert("#ya")).toBe(true);                    // lo que ya era inerte antes no se toca
    expect(isInert("#o-root")).toBe(true);                // el diálogo ya cerrado queda inerte mientras dura su animación de salida
  });

  it("restaura el foco al elemento que abrió el diálogo y, si cierra uno inferior antes, el destino pasa al de encima", async () => {
    html(`<main id="app"><button id="card">tarjeta</button><div id="host"></div></main>`);
    const outer = build($("#host"), "o", `<button id="eliminar">Eliminar</button><div id="slot"></div>`);
    $("#card").focus();
    const offO = registerModal(outer);
    $("#eliminar").focus();
    const inner = build($("#slot"), "i", `<button aria-label="i1"></button>`);
    const offI = registerModal(inner);
    offO(); // se cierra primero el exterior (no es el superior): no debe tocar el foco
    expect(inner.panel.contains(document.activeElement)).toBe(true);
    offI(); // al cerrar el interior vuelve a la tarjeta que abrió el exterior (el botón «Eliminar» ya no es válido: su diálogo se cerró)
    expect($("#card")).toHaveFocus();
  });

  it("un diálogo ya cerrado, aún en el DOM por su animación de salida, sigue inerte aunque se recalcule el aislamiento: no recibe el foco de vuelta", () => {
    // Visor y confirmación como hermanos (history). Se cierra primero el visor y después la confirmación, en la misma tanda.
    html(`<main id="app"><button id="tarjeta">tarjeta</button><div id="host"></div></main>`);
    const visor = build($("#host"), "v", `<button id="v-eliminar">Eliminar</button>`);
    $("#tarjeta").focus();
    const offV = registerModal(visor);
    $("#v-eliminar").focus();
    const confirm = build($("#host"), "c", `<button id="c-ok">Confirmar</button>`);
    const offC = registerModal(confirm);
    $("#c-ok").focus();
    offV();                                   // el visor se cierra (no es el superior); su contenido sigue en el DOM un rato
    expect(visor.root.hasAttribute("inert")).toBe(true);
    offC();                                   // la confirmación se cierra: se recalcula el aislamiento…
    expect(visor.root.hasAttribute("inert")).toBe(true);   // …y el visor en salida NO deja de ser inerte (antes se le quitaba)
    expect(confirm.root.hasAttribute("inert")).toBe(true);
    expect($("#v-eliminar")).not.toHaveFocus();            // el foco no vuelve a un botón de un diálogo ya cerrado…
    expect($("#tarjeta")).toHaveFocus();                   // …sino a la tarjeta que abrió el visor
  });

  it("si el elemento que abrió el diálogo ya no existe, el foco va a <main> (reserva) y no se pierde en body", () => {
    html(`<main id="m"><button id="opener">abrir</button><div id="host"></div></main>`);
    const d = build($("#host"), "d", `<button aria-label="x"></button>`);
    $("#opener").focus();
    const off = registerModal(d);
    $("#opener").remove();
    off();
    expect($("#m")).toHaveFocus();
  });

  it("desregistrar es idempotente y libera listeners, scroll e inert", async () => {
    html(`<main id="page"><button id="o">abrir</button></main><div id="host"></div>`);
    const add = vi.spyOn(document, "addEventListener"); const remove = vi.spyOn(document, "removeEventListener");
    const d = build($("#host"), "d", `<button aria-label="x"></button>`);
    $("#o").focus();
    const off = registerModal(d);
    expect(activeScrollLocks()).toBe(1);
    const addedKeys = add.mock.calls.filter(([t]) => t === "keydown" || t === "focusin");
    expect(addedKeys.map(([t]) => t).sort()).toEqual(["focusin", "keydown"]); // un único par de listeners
    off(); off(); off();
    expect(openModalCount()).toBe(0);
    expect(activeScrollLocks()).toBe(0);
    expect(document.querySelectorAll("#page[inert]").length).toBe(0);
    const removed = remove.mock.calls.filter(([t]) => t === "keydown" || t === "focusin");
    expect(removed.map(([t]) => t).sort()).toEqual(["focusin", "keydown"]);
    // con los listeners retirados, Escape ya no llega a nadie
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(d.close).not.toHaveBeenCalled();
    add.mockRestore(); remove.mockRestore();
  });
});

/**
 * Un elemento que supera el filtro de getTabbables pero NO acepta el foco (como el contenido de un <details> cerrado o con
 * `content-visibility:hidden` en un navegador real). Se simula por instancia (sin tocar el comportamiento global de jsdom): su
 * `focus()` es un espía que no hace nada.
 */
function reject(el: HTMLElement) { const spy = vi.fn(); el.focus = spy as unknown as typeof el.focus; return spy; }

describe("focusNextTabbable — Tab robusto ante candidatos que rechazan el foco", () => {
  const make = (n: number) => { html(`<div id="r">${Array.from({ length: n }, (_, i) => `<button id="b${i}">b${i}</button>`).join("")}</div>`); return Array.from(document.querySelectorAll<HTMLElement>("button")); };

  it("caso normal: avanza, retrocede y da la vuelta como antes", () => {
    const [a, b, c] = make(3) as [HTMLElement, HTMLElement, HTMLElement];
    a.focus();
    expect(focusNextTabbable([a, b, c], document.activeElement, false)).toBe(b); expect(b).toHaveFocus();
    expect(focusNextTabbable([a, b, c], document.activeElement, false)).toBe(c);
    expect(focusNextTabbable([a, b, c], document.activeElement, false)).toBe(a); // vuelta al principio
    expect(focusNextTabbable([a, b, c], document.activeElement, true)).toBe(c);  // y hacia atrás
  });

  it("un candidato que rechaza el foco se salta y Tab avanza al siguiente válido (una sola llamada a focus() sobre el rechazado)", () => {
    const [a, b, c] = make(3) as [HTMLElement, HTMLElement, HTMLElement];
    const spyB = reject(b);
    a.focus();
    expect(focusNextTabbable([a, b, c], document.activeElement, false)).toBe(c);
    expect(c).toHaveFocus();
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("Shift+Tab hace lo mismo en sentido inverso", () => {
    const [a, b, c] = make(3) as [HTMLElement, HTMLElement, HTMLElement];
    const spyB = reject(b);
    c.focus();
    expect(focusNextTabbable([a, b, c], document.activeElement, true)).toBe(a);
    expect(a).toHaveFocus();
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("varios candidatos consecutivos que rechazan: salta todos hasta el primero válido", () => {
    const [a, b, c, d, e] = make(5) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    const spies = [reject(b), reject(c), reject(d)];
    a.focus();
    expect(focusNextTabbable([a, b, c, d, e], document.activeElement, false)).toBe(e);
    for (const sp of spies) expect(sp).toHaveBeenCalledTimes(1);
    expect(focusNextTabbable([a, b, c, d, e], document.activeElement, false)).toBe(a); // y da la vuelta saltando nada
  });

  it("si todos los demás rechazan, el foco se queda en el elemento activo (sigue siendo válido) y cada rechazado se intenta una sola vez", () => {
    const [a, b, c] = make(3) as [HTMLElement, HTMLElement, HTMLElement];
    const spies = [reject(b), reject(c)];
    a.focus();
    expect(focusNextTabbable([a, b, c], document.activeElement, false)).toBe(a);
    expect(a).toHaveFocus();
    for (const sp of spies) expect(sp).toHaveBeenCalledTimes(1);
  });

  it("si NINGÚN candidato acepta el foco devuelve null, tras exactamente una llamada a focus() por candidato (sin bucles)", () => {
    const items = make(4);
    const spies = items.map(reject);
    document.body.focus();
    expect(focusNextTabbable(items, document.activeElement, false)).toBeNull();
    for (const sp of spies) expect(sp).toHaveBeenCalledTimes(1);
    expect(focusNextTabbable(items, document.activeElement, true)).toBeNull();
    for (const sp of spies) expect(sp).toHaveBeenCalledTimes(2); // una más por la segunda pulsación, no una cadena ilimitada
  });

  it("cero y un solo elemento mantienen su comportamiento", () => {
    expect(focusNextTabbable([], document.activeElement, false)).toBeNull();
    const [a] = make(1) as [HTMLElement];
    a.focus();
    expect(focusNextTabbable([a], document.activeElement, false)).toBe(a);
    expect(focusNextTabbable([a], document.activeElement, true)).toBe(a);
    expect(a).toHaveFocus();
  });
});

describe("registerModal — el listener de Tab con candidatos que rechazan el foco", () => {
  it("Tab y Shift+Tab saltan al candidato que rechaza y el foco nunca escapa al fondo; si ninguno acepta, se queda en el panel", async () => {
    html(`<main><button id="fuera">fuera</button></main><div id="host"></div>`);
    const user = userEvent.setup();
    const d = build($("#host"), "d", `<button id="a">a</button><button id="b">b</button><button id="c">c</button>`);
    const spyB = reject($("#b"));
    const off = registerModal(d);
    expect($("#a")).toHaveFocus();
    await user.tab(); expect($("#c")).toHaveFocus();              // b rechaza: se salta
    await user.tab(); expect($("#a")).toHaveFocus();              // vuelta
    await user.tab({ shift: true }); expect($("#c")).toHaveFocus(); // hacia atrás también salta b
    expect(spyB).toHaveBeenCalledTimes(1);                         // solo se intentó cuando el recorrido tenía que pasar por él
    // ahora todos rechazan: el foco está en c (válido) y los otros se intentan una vez cada uno; luego, panel si c también rechaza
    const spyA = reject($("#a")), spyC = reject($("#c"));
    d.panel.focus();
    await user.tab();
    expect(d.panel).toHaveFocus();
    expect([spyA.mock.calls.length, spyB.mock.calls.length, spyC.mock.calls.length]).toEqual([1, 2, 1]); // una llamada por candidato en esta pulsación (b ya llevaba una)
    await user.tab({ shift: true });
    expect(d.panel).toHaveFocus();
    expect($("#fuera")).not.toHaveFocus();
    off();
  });
});

