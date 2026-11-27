"use client";
import { forwardRef } from "react";

/**
 * Aviso general de un formulario de autenticación: UNA región `role="alert"` (no una por mensaje) que se monta cuando hay errores y se
 * desmonta al reenviar, de modo que cada fallo se anuncia de nuevo. `tabIndex={-1}` permite llevarle el foco cuando el error no es de
 * un campo (ver `focusFirstError`). Los errores de campo NO pasan por aquí: siguen enlazados a su control mediante `aria-describedby`.
 */
export const FormAlert = forwardRef<HTMLDivElement, { messages: readonly string[] }>(function FormAlert({ messages }, ref) {
  if (messages.length === 0) return null;
  return (
    <div ref={ref} role="alert" tabIndex={-1} className="space-y-1 rounded text-sm text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
      {messages.map((m) => <p key={m}>{m}</p>)}
    </div>
  );
});
