import { StrictMode, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal, ToastProvider, useToast } from "@/components/ui";

/**
 * Fase H.5 — avisos accesibles: no desaparecen solos (WCAG 2.2.1) y se cierran con «Cerrar aviso» (ratón, teclado, lector de pantalla).
 * El foco solo se mueve al cerrar si estaba dentro del aviso. LIMITACIONES de jsdom: no es un lector de pantalla (el anuncio real de un aviso
 * nuevo en la región `status` se comprueba con NVDA/VoiceOver) y no aplica CSS (el aspecto del botón y de su foco exige navegador).
 */
function Controls() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success("Guardado")}>Éxito</button>
      <button type="button" onClick={() => toast.error("Fallo al subir")}>Error</button>
      <button type="button" onClick={() => toast.info("Dato curioso")}>Info</button>
      <input aria-label="Campo" />
    </>
  );
}
const renderApp = () => render(<ToastProvider><main><Controls /></main></ToastProvider>);   // con <main>, para detectar un robo de foco hacia la región principal
const pushAll = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Éxito" }));
  await user.click(screen.getByRole("button", { name: "Error" }));
  await user.click(screen.getByRole("button", { name: "Info" }));
};
const closeButtons = () => screen.queryAllByRole("button", { name: "Cerrar aviso" });
const gone = (text: string) => waitFor(() => expect(screen.queryByText(text)).not.toBeInTheDocument(), { timeout: 4000 });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });   // en este orden: el espía de setTimeout se creó sobre el temporizador simulado

describe("avisos — no desaparecen solos", () => {
  it("un aviso (éxito, error o info) sigue visible aunque pase mucho tiempo", () => {
    vi.useFakeTimers();
    renderApp();
    for (const name of ["Éxito", "Error", "Info"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByText("Guardado")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });          // más que los antiguos 4 s y 7 s
    expect(screen.getByText("Guardado")).toBeInTheDocument();
    expect(screen.getByText("Fallo al subir")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.getByText("Guardado")).toBeInTheDocument();
    expect(screen.getByText("Fallo al subir")).toBeInTheDocument();
    expect(screen.getByText("Dato curioso")).toBeInTheDocument();
    expect(closeButtons()).toHaveLength(3);
  });

  it("no se programa ningún temporizador de 4 s ni de 7 s al mostrar un aviso", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    renderApp();
    for (const name of ["Éxito", "Error"]) fireEvent.click(screen.getByRole("button", { name }));
    const delays = spy.mock.calls.map((c) => c[1]);
    expect(delays).not.toContain(4000);
    expect(delays).not.toContain(7000);
  });

  it("desmontar el proveedor con avisos abiertos no deja recursos pendientes ni errores", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(60_000); })).not.toThrow();
    expect(err).not.toHaveBeenCalled();
  });
});

describe("avisos — botón de cierre", () => {
  it("cada aviso tiene un botón con nombre accesible «Cerrar aviso» (y el icono es decorativo)", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await pushAll(user);
    expect(closeButtons()).toHaveLength(3);
    for (const b of closeButtons()) {
      expect(b).toHaveAccessibleName("Cerrar aviso");
      expect(b).toHaveAttribute("type", "button");
      expect(b.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(container.querySelectorAll("[role=status] button")).toHaveLength(3);
  });

  it("con el ratón: cerrar un aviso solo retira ese", async () => {
    const user = userEvent.setup();
    renderApp();
    await pushAll(user);
    const status = screen.getByRole("status");
    await user.click(within(screen.getByText("Fallo al subir").parentElement!).getByRole("button", { name: "Cerrar aviso" }));
    await gone("Fallo al subir");
    expect(within(status).getByText("Guardado")).toBeInTheDocument();
    expect(within(status).getByText("Dato curioso")).toBeInTheDocument();
    expect(closeButtons()).toHaveLength(2);
  });

  it("con el teclado: Tab llega al botón y Enter lo cierra; con Espacio también", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    await user.tab();                                                    // del botón «Éxito» → Error → Info → Campo → «Cerrar aviso»
    await user.tab(); await user.tab(); await user.tab();
    expect(closeButtons()[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    await gone("Guardado");
    await user.click(screen.getByRole("button", { name: "Info" }));
    closeButtons()[0]!.focus();
    await user.keyboard(" ");
    await gone("Dato curioso");
    expect(closeButtons()).toHaveLength(0);
  });

  it("varios avisos son independientes: se cierran en cualquier orden y los demás conservan su texto y orden", async () => {
    const user = userEvent.setup();
    renderApp();
    await pushAll(user);
    const order = () => within(screen.getByRole("status")).getAllByText(/Guardado|Fallo al subir|Dato curioso/).map((n) => n.textContent);
    expect(order()).toEqual(["Guardado", "Fallo al subir", "Dato curioso"]);
    await user.click(closeButtons()[1]!);
    await gone("Fallo al subir");
    expect(order()).toEqual(["Guardado", "Dato curioso"]);
    await user.click(screen.getByRole("button", { name: "Error" }));                 // uno nuevo mientras quedan otros
    expect(order()).toEqual(["Guardado", "Dato curioso", "Fallo al subir"]);
    await user.click(closeButtons()[0]!);
    await gone("Guardado");
    expect(order()).toEqual(["Dato curioso", "Fallo al subir"]);
  });

  it("un aviso idéntico (mismo tipo y texto) a uno visible no se duplica, y tras cerrarlo puede volver a mostrarse", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    expect(screen.getAllByText("Guardado")).toHaveLength(1);
    expect(closeButtons()).toHaveLength(1);
    await user.click(closeButtons()[0]!);
    await gone("Guardado");
    await user.click(screen.getByRole("button", { name: "Éxito" }));     // tras cerrarlo, el mismo texto vuelve a poder mostrarse
    expect(screen.getAllByText("Guardado")).toHaveLength(1);
  });
});

describe("avisos — foco al cerrar", () => {
  it("si el foco estaba en el aviso y no queda otro, vuelve al elemento donde estaba antes de entrar", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    const campo = screen.getByRole("textbox", { name: "Campo" });
    campo.focus();
    await user.tab();                                                    // el siguiente tabulable es «Cerrar aviso»
    expect(closeButtons()[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(campo).toHaveFocus();                                         // no se pierde en <body>
    await gone("Guardado");
    expect(campo).toHaveFocus();
  });

  it("la restauración al elemento de origen se solicita SIN desplazamiento (preventScroll) y solo a ese elemento", async () => {
    // jsdom no desplaza la página: solo se puede comprobar que `focus` se llama con `{ preventScroll: true }`, no que el navegador no se mueva.
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    const campo = screen.getByRole("textbox", { name: "Campo" });
    campo.focus();
    await user.tab();
    const focusSpy = vi.spyOn(campo, "focus");
    await user.keyboard("{Enter}");
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(campo).toHaveFocus();
  });

  it("si quedan otros avisos, el foco pasa al botón del vecino (siguiente; si es el último, el anterior)", async () => {
    const user = userEvent.setup();
    renderApp();
    await pushAll(user);
    closeButtons()[0]!.focus();
    await user.keyboard("{Enter}");
    await gone("Guardado");
    expect(closeButtons()).toHaveLength(2);
    expect(closeButtons()[0]).toHaveFocus();                              // era el del aviso siguiente («Fallo al subir»)
    closeButtons()[1]!.focus();                                           // el último («Dato curioso»)
    await user.keyboard("{Enter}");
    await gone("Dato curioso");
    expect(closeButtons()).toHaveLength(1);
    expect(closeButtons()[0]).toHaveFocus();                              // el anterior
  });

  it("si el foco NO estaba en el aviso, cerrarlo no mueve el foco (no se roba)", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    const campo = screen.getByRole("textbox", { name: "Campo" });
    campo.focus();
    fireEvent.click(closeButtons()[0]!);                                  // fireEvent no mueve el foco: el usuario seguía en el campo
    await gone("Guardado");
    expect(campo).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveFocus();
  });

  it("si el foco no estaba en ninguna parte (body), cerrar con un clic sin foco lo deja donde estaba", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(closeButtons()[0]!);
    await gone("Guardado");
    expect(document.body).toHaveFocus();
  });
});

describe("avisos — región y API", () => {
  it("la región role=status (aria-live=polite) existe desde el principio y contiene los avisos", async () => {
    const user = userEvent.setup();
    renderApp();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "false");              // explícito: role=status implica «true» y reanunciaría los avisos que siguen abiertos
    expect(status).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Error" }));
    expect(within(status).getByText("Fallo al subir")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("la API de useToast no cambia: success, error e info; el error mantiene su estilo propio", async () => {
    const user = userEvent.setup();
    renderApp();
    await pushAll(user);
    const kind = (t: string) => screen.getByText(t).parentElement!;
    expect(kind("Fallo al subir")).toHaveClass("bg-danger");
    expect(kind("Guardado")).toHaveClass("bg-ink");
    expect(kind("Dato curioso")).toHaveClass("bg-ink");
  });

  it("useToast fuera de ToastProvider sigue lanzando el mismo error", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);    // React informa del error de render; se silencia
    const Bad = () => { useToast(); return null; };
    expect(() => render(<Bad />)).toThrow("useToast requiere <ToastProvider>");
  });
});

function ToastLauncher() {
  const toast = useToast();
  return <button type="button" onClick={() => toast.info("Dentro")}>Lanzar</button>;
}

describe("H.5 (cierre) — origen desaparecido e integración con un diálogo abierto", () => {
  it("si el elemento de origen ya no existe al cerrar, el foco va a la región principal (no se pierde en <body>)", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Éxito" }));
    const campo = screen.getByRole("textbox", { name: "Campo" });
    campo.focus();
    await user.tab();
    expect(closeButtons()[0]).toHaveFocus();
    campo.remove();                                                       // el origen desaparece mientras el foco está en el aviso
    await user.keyboard("{Enter}");
    await gone("Guardado");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  /**
   * Caracterización de lo que HOY hace `modal-stack` con los avisos (no se modifica aquí): la región de avisos es `role=status`/`aria-live`, que
   * el aislamiento deliberadamente NO marca `inert`. Con un diálogo abierto el aviso es visible y se puede cerrar con el ratón, pero Tab queda
   * atrapado en el diálogo, así que el botón no es alcanzable con el teclado hasta cerrarlo (entonces el aviso, que ya no caduca, sigue ahí).
   * LIMITACIÓN: jsdom no es un lector de pantalla; con `aria-modal` algunos lectores podrían además no llegar al botón (se comprueba a mano).
   */
  function WithDialog() {
    const toast = useToast();
    return (
      <>
        <main><button type="button">Fondo</button></main>
        <Modal open onClose={() => undefined} title="Diálogo">
          <button type="button" onClick={() => toast.error("Fallo dentro")}>Lanzar error</button>
          <button type="button">Otro</button>
        </Modal>
      </>
    );
  }

  it("con un diálogo abierto, el aviso no queda inerte, se muestra y se puede cerrar con el ratón sin sacar el foco del diálogo", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><WithDialog /></ToastProvider>);
    const dlg = await screen.findByRole("dialog", { name: "Diálogo" });
    await user.click(within(dlg).getByRole("button", { name: "Lanzar error" }));
    const status = screen.getByRole("status");
    expect(within(status).getByText("Fallo dentro")).toBeInTheDocument();
    expect(status.closest("[inert]")).toBeNull();                          // la región viva queda fuera del aislamiento del fondo
    expect(document.querySelector("main")!.closest("[inert]")).not.toBeNull();   // mientras que el fondo sí es inerte
    await user.click(within(status).getByRole("button", { name: "Cerrar aviso" }));
    await gone("Fallo dentro");
    expect(dlg.contains(document.activeElement)).toBe(true);               // el foco sigue dentro del diálogo
  });

  it("H5-01 — con un diálogo abierto, Tab llega al botón del aviso (cierra el ciclo del diálogo) y Enter lo cierra devolviendo el foco al diálogo", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><WithDialog /></ToastProvider>);
    const dlg = await screen.findByRole("dialog", { name: "Diálogo" });
    await user.click(within(dlg).getByRole("button", { name: "Lanzar error" }));
    const cerrar = screen.getByRole("button", { name: "Cerrar aviso" });
    const visited: Element[] = [];
    for (let i = 0; i < 6; i++) { await user.tab(); visited.push(document.activeElement!); }
    expect(visited).toContain(cerrar);                                    // ahora alcanzable
    const allowed = [...within(dlg).getAllByRole("button"), cerrar];
    for (const el of visited) expect(allowed).toContain(el);               // y el foco nunca sale al fondo inerte
    cerrar.focus();
    await user.keyboard("{Enter}");
    await gone("Fallo dentro");
    expect(dlg.contains(document.activeElement)).toBe(true);               // vuelve al elemento del diálogo donde estaba
    expect(document.querySelector("main")!.closest("[inert]")).not.toBeNull();   // el aislamiento del fondo sigue intacto
  });

  it("H5-01 — el orden del ciclo es: elementos del diálogo, luego los avisos, y vuelta; Shift+Tab desde el primero va al último aviso", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><WithDialog /></ToastProvider>);
    const dlg = await screen.findByRole("dialog", { name: "Diálogo" });
    await user.click(within(dlg).getByRole("button", { name: "Lanzar error" }));
    const cerrar = screen.getByRole("button", { name: "Cerrar aviso" });
    const [primero, ...resto] = within(dlg).getAllByRole("button");
    const ultimo = resto[resto.length - 1]!;
    ultimo.focus();
    await user.tab();
    expect(cerrar).toHaveFocus();                                          // después del último del diálogo, el aviso
    await user.tab();
    expect(document.activeElement).not.toBe(cerrar);                       // y da la vuelta al diálogo
    expect(dlg.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    primero!.focus();
    await user.tab({ shift: true });
    expect(cerrar).toHaveFocus();                                          // hacia atrás desde el primero: el último aviso
  });

  it("H5-01 — Escape con el foco en el aviso sigue cerrando el diálogo (el aviso no lo impide)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ToastProvider><Modal open onClose={onClose} title="Cerrable"><ToastLauncher /></Modal></ToastProvider>);
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Lanzar" }));
    screen.getByRole("button", { name: "Cerrar aviso" }).focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("H.5.1 — acumulación, repetición de Enter, desplazamiento y anuncios", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    function Many() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => { for (let i = 1; i <= 8; i++) toast.info(`Info ${i}`); }}>Muchos info</button>
          <button type="button" onClick={() => { for (let i = 1; i <= 8; i++) toast.error(`Error ${i}`); }}>Muchos error</button>
          <button type="button" onClick={() => { toast.error("Error A"); for (let i = 1; i <= 5; i++) toast.success(`Ok ${i}`); }}>Mezcla</button>
        </>
      );
    }
    render(<ToastProvider><main><Many /></main></ToastProvider>);
    return user;
  };

  it("H5-02 — los avisos de éxito/info se limitan a los 3 más recientes", async () => {
    const user = userEvent.setup();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Muchos info" }));
    await waitFor(() => expect(closeButtons()).toHaveLength(3), { timeout: 4000 });
    const texts = within(screen.getByRole("status")).getAllByText(/Info \d/).map((n) => n.textContent);
    expect(texts).toEqual(["Info 6", "Info 7", "Info 8"]);
  });

  it("H5-02 — los errores NUNCA se retiran por el límite (se conservan todos los distintos) y el límite no los cuenta", async () => {
    const user = userEvent.setup();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Muchos error" }));
    expect(closeButtons()).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "Mezcla" }));
    await waitFor(() => expect(screen.queryByText("Ok 1")).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText("Error A")).toBeInTheDocument();
    expect(screen.getAllByText(/^Error \d$/)).toHaveLength(8);
    expect(["Ok 3", "Ok 4", "Ok 5"].every((t) => screen.queryByText(t))).toBe(true);
  });

  it("H5-02 — la región se coloca sobre la barra móvil (bottom con la altura de la barra y la zona segura), acota su altura y se desplaza", () => {
    renderApp();
    const status = screen.getByRole("status");
    expect(status.className).toContain("bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))]");
    expect(status.className).toContain("lg:bottom-4");
    expect(status.className).toContain("max-h-[50dvh]");
    expect(status.className).toContain("overflow-y-auto");
  });

  it("H5-03 — Enter mantenido (repeat) no cierra avisos consecutivos; el primer Enter sí cierra", async () => {
    const user = userEvent.setup();
    renderApp();
    await pushAll(user);
    const first = closeButtons()[0]!;
    const notPrevented = fireEvent.keyDown(first, { key: "Enter", repeat: true });
    expect(notPrevented).toBe(false);                                      // la repetición se cancela: el navegador no genera el click
    expect(fireEvent.keyDown(first, { key: "Enter", repeat: false })).toBe(true);   // la primera pulsación no se toca
    expect(fireEvent.keyDown(first, { key: " ", repeat: true })).toBe(true);        // Espacio actúa al soltar: no se intercepta
    expect(closeButtons()).toHaveLength(3);
    first.focus();
    await user.keyboard("{Enter}");                                        // una pulsación real cierra solo uno
    await gone("Guardado");
    expect(closeButtons()).toHaveLength(2);
  });

  it("H5-03 — con el foco ya trasladado al vecino, la repetición de Enter sobre él tampoco lo cierra", async () => {
    const user = userEvent.setup();
    renderApp();
    await pushAll(user);
    closeButtons()[0]!.focus();
    await user.keyboard("{Enter}");
    await gone("Guardado");
    const neighbor = closeButtons()[0]!;
    expect(neighbor).toHaveFocus();
    fireEvent.keyDown(neighbor, { key: "Enter", repeat: true });
    expect(closeButtons()).toHaveLength(2);
  });

  it("H5-04 — decisión: la región sigue siendo «polite» (los errores bloqueantes de los formularios ya usan role=alert en línea)", () => {
    renderApp();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("H6-01 — publica la altura efectiva de la región en --toast-inset mientras hay avisos y la retira al cerrar y al desmontar", async () => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { return { top: 400, bottom: 460, left: 0, right: 0, width: 0, height: 60, x: 0, y: 400, toJSON() {} } as DOMRect; };
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    try {
      const user = userEvent.setup();
      const { unmount } = renderApp();
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--toast-inset")).toBe("");
      await user.click(screen.getByRole("button", { name: "Error" }));
      expect(root.style.getPropertyValue("--toast-inset")).toBe("216px");     // (600 − 400) + 16 de holgura
      await user.click(closeButtons()[0]!);
      await gone("Fallo al subir");
      await waitFor(() => expect(root.style.getPropertyValue("--toast-inset")).toBe(""));
      await user.click(screen.getByRole("button", { name: "Info" }));
      expect(root.style.getPropertyValue("--toast-inset")).toBe("216px");
      unmount();
      expect(root.style.getPropertyValue("--toast-inset")).toBe("");
    } finally { Element.prototype.getBoundingClientRect = original; }
  });
});

/** Corrección A — expulsión de avisos por el límite con el foco DENTRO del aviso expulsado. Se verifica qué elemento recibe realmente el foco. */
describe("A — expulsión por el límite y foco", () => {
  function Feed() {
    const toast = useToast();
    const n = useRef(0);
    return (
      <>
        <button type="button" onClick={() => toast.info(`Info ${++n.current}`)}>Nuevo info</button>
        <button type="button" onClick={() => toast.error(`Error ${++n.current}`)}>Nuevo error</button>
        <input aria-label="Campo" />
      </>
    );
  }
  const setup = () => render(<ToastProvider><main><Feed /></main></ToastProvider>);
  const toastOf = (text: string) => screen.getByText(text).parentElement!;
  const closeOf = (text: string) => within(toastOf(text)).getByRole("button", { name: "Cerrar aviso" });
  // Un aviso que llega mientras el usuario tiene el foco en otro aviso (p. ej. al terminar una petición): `fireEvent` no mueve el foco, como ocurriría en la realidad.
  const addInfos = async (user: ReturnType<typeof userEvent.setup>, n: number) => { for (let i = 0; i < n; i++) await user.click(screen.getByRole("button", { name: "Nuevo info" })); };

  it("el aviso expulsado tenía el foco: pasa al botón del aviso superviviente más cercano (el siguiente), no a <body>", async () => {
    const user = userEvent.setup();
    setup();
    await addInfos(user, 3);                                               // Info 1, 2, 3
    closeOf("Info 1").focus();
    expect(closeOf("Info 1")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));   // Info 4 expulsa a Info 1 (con el foco). fireEvent: un clic real movería el foco al botón
    expect(document.body).not.toHaveFocus();
    expect(closeOf("Info 2")).toHaveFocus();                                 // el foco está en un aviso que SIGUE ahí
    await gone("Info 1");
    expect(["Info 2", "Info 3", "Info 4"].every((t) => screen.queryByText(t))).toBe(true);
    expect(closeOf("Info 2")).toHaveFocus();                                 // y sigue en él cuando acaba la animación de salida
  });

  it("sin foco en los avisos (el usuario está en un campo) la expulsión NO roba el foco ni lo manda a <main>", async () => {
    const user = userEvent.setup();
    setup();
    await addInfos(user, 3);
    const campo = screen.getByRole("textbox", { name: "Campo" });
    campo.focus();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));    // fireEvent no mueve el foco
    await gone("Info 1");
    expect(campo).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveFocus();
  });

  it("el foco en un aviso que NO se expulsa se queda donde está", async () => {
    const user = userEvent.setup();
    setup();
    await addInfos(user, 3);
    closeOf("Info 3").focus();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));   // expulsa a Info 1; el foco estaba en Info 3
    await gone("Info 1");
    expect(closeOf("Info 3")).toHaveFocus();
  });

  it("los errores no se expulsan: con el foco en un error y muchos avisos nuevos, el error sigue y conserva el foco", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Nuevo error" }));   // Error 1
    closeOf("Error 1").focus();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));
    await waitFor(() => expect(screen.queryByText("Info 2")).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText("Error 1")).toBeInTheDocument();
    expect(closeOf("Error 1")).toHaveFocus();
    expect(screen.getAllByText(/^Info \d+$/)).toHaveLength(3);
  });

  it("si el aviso expulsado con el foco no tiene un vecino superviviente en el DOM, se restaura el origen (el foco no se pierde)", async () => {
    const user = userEvent.setup();
    setup();
    await addInfos(user, 3);
    const campo = screen.getByRole("textbox", { name: "Campo" });
    campo.focus();
    await user.tab();                                                          // entra en la región de avisos: el origen es el campo
    expect(closeOf("Info 1")).toHaveFocus();
    // Hace desaparecer del DOM a los supervivientes (simula nodos no montados): solo queda el origen como destino válido.
    for (const t of ["Info 2", "Info 3"]) toastOf(t).remove();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));
    expect(campo).toHaveFocus();
  });

  it("expulsión y cierre manual no producen restauraciones dobles ni referencias obsoletas", async () => {
    const user = userEvent.setup();
    setup();
    await addInfos(user, 3);
    const info2 = closeOf("Info 2"); const info3 = closeOf("Info 3");
    const f2 = vi.spyOn(info2, "focus"); const f3 = vi.spyOn(info3, "focus");
    closeOf("Info 1").focus();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo info" }));    // expulsión: UNA restauración, al siguiente (Info 2)
    expect(f2).toHaveBeenCalledTimes(1);
    expect(f3).not.toHaveBeenCalled();
    await gone("Info 1");
    expect(info2).toHaveFocus();
    await user.keyboard("{Enter}");                                           // cierre manual del que tiene el foco: pasa a Info 3, no a la referencia expulsada
    await gone("Info 2");
    expect(f3).toHaveBeenCalledTimes(1);
    expect(info3).toHaveFocus();
    // Doble cierre rápido del mismo aviso (durante su salida): el segundo no hace nada ni vuelve a mover el foco.
    const info4 = closeOf("Info 4");
    const f4 = vi.spyOn(info4, "focus");
    info3.focus();
    f3.mockClear();
    fireEvent.click(info3); fireEvent.click(info3);
    await gone("Info 3");
    expect(f3).not.toHaveBeenCalled();
    expect(f4).toHaveBeenCalledTimes(1);                                        // una sola restauración, al superviviente
    expect(info4).toHaveFocus();
    expect(screen.getAllByText(/^Info \d+$/)).toHaveLength(1);
  });

  it("con vecinos a ambos lados, el foco pasa al SIGUIENTE (y no al anterior); si era el último, al anterior", async () => {
    const user = userEvent.setup();
    setup();
    await addInfos(user, 3);
    closeOf("Info 2").focus();
    await user.keyboard("{Enter}");
    await gone("Info 2");
    expect(closeOf("Info 3")).toHaveFocus();                                  // siguiente, no Info 1
    await user.keyboard("{Enter}");                                           // Info 3 era ahora el último: el anterior
    await gone("Info 3");
    expect(closeOf("Info 1")).toHaveFocus();
  });

  it("varios avisos en el mismo evento (lista fresca) y StrictMode: el límite se respeta sin duplicados ni efectos dobles", async () => {
    const user = userEvent.setup();
    function Burst() { const toast = useToast(); return <button type="button" onClick={() => { for (let i = 1; i <= 7; i++) toast.info(`R${i}`); }}>Ráfaga</button>; }
    render(<StrictMode><ToastProvider><main><Burst /></main></ToastProvider></StrictMode>);
    await user.click(screen.getByRole("button", { name: "Ráfaga" }));
    await waitFor(() => expect(screen.queryByText("R1")).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getAllByText(/^R\d$/).map((n) => n.textContent)).toEqual(["R5", "R6", "R7"]);
    expect(closeButtons()).toHaveLength(3);
  });
});

/** Diálogos ANIDADOS (como la ficha de prenda con su confirmación) con un aviso presente: ciclo de Tab, aislamiento y restauración del foco. */
describe("avisos con diálogos anidados", () => {
  function Nested() {
    const [inner, setInner] = useState(false);
    const toast = useToast();
    return (
      <>
        <main><button type="button">Fondo</button></main>
        <Modal open onClose={() => undefined} title="Exterior">
          <button type="button" onClick={() => setInner(true)}>Abrir interior</button>
          <button type="button">Otro exterior</button>
          <Modal open={inner} onClose={() => setInner(false)} title="Interior">
            <button type="button" onClick={() => toast.error("Fallo interior")}>Lanzar</button>
            <button type="button">Otro interior</button>
          </Modal>
        </Modal>
      </>
    );
  }
  const open = async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Nested /></ToastProvider>);
    await user.click(await screen.findByRole("button", { name: "Abrir interior" }));
    const inner = await screen.findByRole("dialog", { name: "Interior" });
    await user.click(within(inner).getByRole("button", { name: "Lanzar" }));
    return { user, inner, cerrar: screen.getByRole("button", { name: "Cerrar aviso" }) };
  };
  const forbidden = () => [screen.getByRole("button", { name: "Fondo", hidden: true }), screen.getByRole("button", { name: "Abrir interior", hidden: true }), screen.getByRole("button", { name: "Otro exterior", hidden: true })];

  it("Tab y Shift+Tab recorren SOLO el diálogo superior y el aviso, en ambos sentidos y con vuelta; nunca llegan al diálogo exterior ni al fondo", async () => {
    const { user, inner, cerrar } = await open();
    const allowed = [...within(inner).getAllByRole("button"), cerrar];
    const forward: Element[] = [];
    for (let i = 0; i < 8; i++) { await user.tab(); forward.push(document.activeElement!); }
    expect(forward).toContain(cerrar);
    for (const el of forward) expect(allowed).toContain(el);
    const back: Element[] = [];
    for (let i = 0; i < 8; i++) { await user.tab({ shift: true }); back.push(document.activeElement!); }
    expect(back).toContain(cerrar);
    for (const el of back) expect(allowed).toContain(el);
    for (const el of forbidden()) { expect(forward).not.toContain(el); expect(back).not.toContain(el); }
  });

  it("el aislamiento se mantiene con el aviso: el diálogo exterior y el fondo son inertes y la región de avisos no", async () => {
    const { cerrar } = await open();
    expect(screen.getByRole("main", { hidden: true }).closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Otro exterior", hidden: true }).closest("[inert]")).not.toBeNull();     // el contenido del diálogo exterior
    expect(cerrar.closest("[inert]")).toBeNull();
    expect(screen.getByRole("status").closest("[inert]")).toBeNull();
  });

  it("cerrar el aviso con el foco en su botón devuelve el foco al diálogo INTERIOR (no al exterior ni al fondo) y el ciclo sigue funcionando", async () => {
    const { user, inner, cerrar } = await open();
    cerrar.focus();
    await user.keyboard("{Enter}");
    await gone("Fallo interior");
    expect(inner.contains(document.activeElement)).toBe(true);
    for (const el of forbidden()) expect(el).not.toHaveFocus();
    await user.tab();
    expect(inner.contains(document.activeElement)).toBe(true);
  });

  it("cerrar el diálogo interior con Escape estando el foco en el aviso devuelve el foco al elemento que lo abrió (en el exterior); el exterior sigue abierto", async () => {
    const { user, cerrar } = await open();
    cerrar.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Interior" })).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByRole("dialog", { name: "Exterior" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Abrir interior" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Cerrar aviso" })).toBeInTheDocument();      // el aviso (que ya no caduca) sigue ahí
  });

  it("abrir y cerrar varios diálogos no deja la región de avisos asociada al equivocado: tras cerrar todo, Tab ya no la incluye en ningún ciclo de diálogo", async () => {
    const user = userEvent.setup();
    function Toggle() { const [o, set] = useState(true); const toast = useToast(); return <><button type="button" onClick={() => set(true)}>Reabrir</button><button type="button" onClick={() => toast.info("Hola")}>Aviso</button><Modal open={o} onClose={() => set(false)} title="Uno"><button type="button">Dentro</button></Modal></>; }
    render(<ToastProvider><main><Toggle /></main></ToastProvider>);
    const dlg = await screen.findByRole("dialog", { name: "Uno" });
    expect(dlg).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 4000 });
    await user.click(screen.getByRole("button", { name: "Aviso" }));
    const seen: Element[] = [];
    for (let i = 0; i < 4; i++) { await user.tab(); seen.push(document.activeElement!); }
    expect(seen).toContain(screen.getByRole("button", { name: "Cerrar aviso" }));         // sin diálogo: ciclo normal de la página, que sí llega al aviso
    expect(seen).toContain(screen.getByRole("button", { name: "Reabrir" }));
  });
});

/** ResizeObserver: se sustituye por un doble que registra `observe`/`disconnect` y permite disparar la devolución de llamada. LIMITACIÓN: no mide el layout. */
describe("--toast-inset y ResizeObserver (con un doble)", () => {
  class FakeRO {
    static instances: FakeRO[] = [];
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
    constructor(public cb: () => void) { FakeRO.instances.push(this); }
  }
  const original = Element.prototype.getBoundingClientRect;
  let top = 400;
  const installed = () => {
    FakeRO.instances = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
    Element.prototype.getBoundingClientRect = function () { return { top, bottom: top + 60, left: 0, right: 0, width: 0, height: 60, x: 0, y: top, toJSON() {} } as DOMRect; };
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  };
  afterEach(() => { delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver; Element.prototype.getBoundingClientRect = original; top = 400; document.documentElement.style.removeProperty("--toast-inset"); });
  const inset = () => document.documentElement.style.getPropertyValue("--toast-inset");

  it("observa la región (observe) con el aviso presente y, al cambiar su tamaño, vuelve a publicar la altura", async () => {
    installed();
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Error" }));
    const ro = FakeRO.instances.at(-1)!;
    expect(ro.observe).toHaveBeenCalledTimes(1);
    expect(ro.observe).toHaveBeenCalledWith(screen.getByRole("status"));
    expect(inset()).toBe("216px");
    top = 300;                                                              // la región crece hacia arriba (más avisos o texto en varias líneas)
    act(() => ro.cb());
    expect(inset()).toBe("316px");
    top = 500;
    act(() => ro.cb());
    expect(inset()).toBe("116px");
  });

  it("al cambiar los avisos, desconecta el observador anterior y no deja más de uno activo", async () => {
    installed();
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Error" }));
    await user.click(screen.getByRole("button", { name: "Info" }));
    const all = FakeRO.instances;
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const ro of all.slice(0, -1)) expect(ro.disconnect).toHaveBeenCalled();
    expect(all.at(-1)!.disconnect).not.toHaveBeenCalled();
  });

  it("al desmontar, desconecta el observador y elimina la propiedad CSS; sin avisos la propiedad no existe", async () => {
    installed();
    const user = userEvent.setup();
    const { unmount } = renderApp();
    expect(inset()).toBe("");
    await user.click(screen.getByRole("button", { name: "Error" }));
    expect(inset()).not.toBe("");
    const ro = FakeRO.instances.at(-1)!;
    unmount();
    expect(ro.disconnect).toHaveBeenCalled();
    expect(inset()).toBe("");
  });

  it("al cerrar el último aviso la propiedad se elimina y una devolución de llamada tardía del observador no la vuelve a publicar", async () => {
    installed();
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Error" }));
    const ro = FakeRO.instances.at(-1)!;
    await user.click(closeButtons()[0]!);
    await gone("Fallo al subir");
    await waitFor(() => expect(inset()).toBe(""));
    act(() => ro.cb());
    expect(inset()).toBe("");
  });

  it("también escucha el cambio de tamaño de la ventana (resize) y deja de hacerlo al desmontar", async () => {
    installed();
    const user = userEvent.setup();
    const { unmount } = renderApp();
    await user.click(screen.getByRole("button", { name: "Error" }));
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(inset()).toBe("316px");
    unmount();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    expect(inset()).toBe("");
  });
});
