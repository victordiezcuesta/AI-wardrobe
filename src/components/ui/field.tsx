"use client";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

const control =
  "w-full rounded-field border border-stone/70 bg-paper px-4 text-[0.95rem] text-ink placeholder:text-taupe/70 transition-colors focus:border-ink focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-50";

interface FieldShellProps { label: string; hint?: string; error?: string; children: (id: string, describedBy: string | undefined) => ReactNode }

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const msgId = error || hint ? `${id}-msg` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children(id, msgId)}
      {(error || hint) && (
        <p id={msgId} className={cn("text-sm", error ? "text-danger" : "text-taupe")}>{error ?? hint}</p>
      )}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, className, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id, msg) => <input ref={ref} id={id} aria-invalid={!!error} aria-describedby={msg} className={cn(control, "h-11", className)} {...rest} />}
    </FieldShell>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string };
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, className, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id, msg) => <textarea ref={ref} id={id} aria-invalid={!!error} aria-describedby={msg} className={cn(control, "min-h-24 py-3", className)} {...rest} />}
    </FieldShell>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; error?: string };
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, hint, error, className, children, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id, msg) => <select ref={ref} id={id} aria-invalid={!!error} aria-describedby={msg} className={cn(control, "h-11", className)} {...rest}>{children}</select>}
    </FieldShell>
  );
});
