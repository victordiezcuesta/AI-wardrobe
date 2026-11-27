"use client";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

const control =
  "w-full rounded-field border border-control bg-paper px-4 text-[0.95rem] text-ink placeholder:text-taupe transition-colors focus:border-ink focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-50";

/** Un mensaje de error o varios (p. ej. las distintas reglas de una contraseña). Vacío o `undefined` = sin error. */
export type FieldError = string | readonly string[] | undefined;
const errorList = (error: FieldError): string[] => (error === undefined ? [] : typeof error === "string" ? (error ? [error] : []) : error.filter(Boolean));

interface FieldShellProps { label: string; hint?: string; error?: FieldError; children: (id: string, describedBy: string | undefined, invalid: boolean) => ReactNode }

/**
 * Etiqueta + control + ayuda + errores. La ayuda y los errores son elementos distintos (`-hint` y `-error`) y pueden verse a la vez;
 * `aria-describedby` solo referencia los que existen (ayuda primero, luego errores). Con un solo error se mantiene el `<p>` de siempre;
 * con varios, una lista.
 */
function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const errors = errorList(error);
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = errors.length > 0 ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children(id, describedBy, errors.length > 0)}
      {hint && <p id={hintId} className="text-sm text-taupe">{hint}</p>}
      {errors.length === 1 && <p id={errorId} className="text-sm text-danger">{errors[0]}</p>}
      {errors.length > 1 && <ul id={errorId} className="space-y-0.5 text-sm text-danger">{errors.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: FieldError };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, className, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id, msg, invalid) => <input ref={ref} id={id} aria-invalid={invalid} aria-describedby={msg} className={cn(control, "h-11", className)} {...rest} />}
    </FieldShell>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: FieldError };
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, className, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id, msg, invalid) => <textarea ref={ref} id={id} aria-invalid={invalid} aria-describedby={msg} className={cn(control, "min-h-24 py-3", className)} {...rest} />}
    </FieldShell>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; error?: FieldError };
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, hint, error, className, children, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id, msg, invalid) => <select ref={ref} id={id} aria-invalid={invalid} aria-describedby={msg} className={cn(control, "h-11", className)} {...rest}>{children}</select>}
    </FieldShell>
  );
});
