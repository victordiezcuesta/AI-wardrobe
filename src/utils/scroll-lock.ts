/**
 * Bloqueo del scroll del documento con contador: el scroll permanece bloqueado mientras haya al menos un bloqueo activo y, al soltar
 * el último, se restaura el valor ORIGINAL de `body.style.overflow` (no se fuerza ""). Antes, cada modal ponía y quitaba `overflow`
 * a ciegas: cerrar uno interior desbloqueaba el scroll aunque el exterior siguiera abierto. No toca el scroll interno de los diálogos.
 */
let count = 0;
let saved = "";

/** Activa un bloqueo y devuelve la función que lo libera (idempotente). */
export function lockScroll(): () => void {
  if (count === 0) {
    saved = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count -= 1;
    if (count === 0) {
      document.body.style.overflow = saved;
      saved = "";
    }
  };
}

/** Bloqueos activos (para diagnóstico y pruebas). */
export const activeScrollLocks = () => count;
