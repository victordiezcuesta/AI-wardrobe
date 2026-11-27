/**
 * Tras un envío fallido, lleva el foco a un sitio útil y predecible, nunca a `body`:
 *   1. el primer campo inválido (`aria-invalid="true"`) del formulario;
 *   2. si no hay errores de campo, el aviso general (`role="alert"`, con `tabIndex={-1}`);
 *   3. si tampoco existe, el botón de envío, solo si está habilitado.
 * Un destino deshabilitado o desconectado se descarta. Devuelve el elemento enfocado o `null`.
 * Se llama DESPUÉS de que React haya pintado el estado de error (en un efecto): el botón ya no está deshabilitado por la carga.
 */
export function focusFirstError(form: HTMLElement | null, alert: HTMLElement | null): HTMLElement | null {
  const usable = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && !el.matches(":disabled");
  const candidates = [
    form?.querySelector<HTMLElement>('[aria-invalid="true"]'),
    alert,
    form?.querySelector<HTMLElement>('button[type="submit"]'),
  ];
  for (const el of candidates) {
    if (!usable(el)) continue;
    el.focus();
    if (el.ownerDocument.activeElement === el) return el;
  }
  return null;
}
