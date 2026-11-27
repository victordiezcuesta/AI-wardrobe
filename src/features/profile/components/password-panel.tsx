"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";
import {
  EMPTY_VALUES, PASSWORD_MESSAGES, createPasswordChangeSubmitter, postPasswordChange,
  type FieldErrors, type PasswordField, type PasswordValues,
} from "@/features/profile/change-password";

const NEW_PASSWORD_HINT = "Mínimo 10 caracteres, con mayúscula, minúscula y número. Máximo 72 bytes UTF-8.";

/** `target` completa el nombre accesible del botón conmutador: «Mostrar <target>» (constante; el estado va en aria-pressed). */
const FIELDS: { name: PasswordField; label: string; target: string; autoComplete: string; hint?: string }[] = [
  { name: "currentPassword", label: "Contraseña actual", target: "contraseña actual", autoComplete: "current-password" },
  { name: "newPassword", label: "Nueva contraseña", target: "nueva contraseña", autoComplete: "new-password", hint: NEW_PASSWORD_HINT },
  { name: "confirmPassword", label: "Confirma la nueva contraseña", target: "confirmación de la nueva contraseña", autoComplete: "new-password" },
];

export type Visibility = Record<PasswordField, boolean>;
export const HIDDEN: Visibility = { currentPassword: false, newPassword: false, confirmPassword: false };

export interface PasswordPanelViewProps {
  values: PasswordValues;
  errors: Partial<Record<PasswordField, string | readonly string[]>>;
  formError?: string;
  success?: boolean;
  loading: boolean;
  visible: Visibility;
  onChange: (field: PasswordField, value: string) => void;
  onToggle: (field: PasswordField) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** Presentación pura (sin estado ni red): la misma pieza que se renderiza en las pruebas. */
export function PasswordPanelView({ values, errors, formError, success, loading, visible, onChange, onToggle, onSubmit }: PasswordPanelViewProps) {
  return (
    <section className="space-y-5 border-t border-stone/50 pt-10" aria-labelledby="contrasena">
      <h2 id="contrasena" className="font-display text-4xl leading-none">Contraseña</h2>
      <p className="max-w-xl text-sm text-taupe">Al cambiarla se cerrarán tus sesiones abiertas en otros dispositivos; esta seguirá abierta.</p>
      <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4" aria-describedby={formError ? "contrasena-error" : undefined}>
        {FIELDS.map((f) => (
          <div key={f.name}>
            <Input
              label={f.label}
              name={f.name}
              type={visible[f.name] ? "text" : "password"}
              autoComplete={f.autoComplete}
              value={values[f.name]}
              onChange={(e) => onChange(f.name, e.target.value)}
              hint={f.hint}
              error={errors[f.name]}
              disabled={loading}
              required
            />
            <button
              type="button"
              onClick={() => onToggle(f.name)}
              aria-pressed={visible[f.name]}
              disabled={loading}
              className="mt-1.5 rounded text-sm text-taupe underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 aria-pressed:font-medium aria-pressed:text-ink"
            >
              Mostrar<span className="sr-only"> {f.target}</span>
            </button>
          </div>
        ))}
        {formError && <p id="contrasena-error" role="alert" className="text-sm text-danger">{formError}</p>}
        <div role="status">{success && <p className="rounded-card bg-linen p-4 text-sm">{PASSWORD_MESSAGES.success}</p>}</div>
        <Button type="submit" loading={loading} className="w-full sm:w-auto">Cambiar contraseña</Button>
      </form>
    </section>
  );
}

export function PasswordPanel() {
  const submitter = useMemo(() => createPasswordChangeSubmitter(postPasswordChange), []);
  const [values, setValues] = useState<PasswordValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState<Visibility>(HIDDEN);
  const formRef = useRef<HTMLDivElement>(null);
  const focusInvalid = useRef(false);

  // Tras un rechazo, el foco va al primer campo con error (el mensaje se anuncia por aria-describedby).
  useEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setSuccess(false); setFormError(undefined); setErrors({});
    setLoading(true);
    const result = await submitter(values);
    if (result === null) return; // duplicado: la petición en curso sigue gestionando el estado
    setLoading(false);
    if (result.status === "success") {
      setValues(EMPTY_VALUES); setVisible(HIDDEN); setErrors({}); setFormError(undefined); setSuccess(true);
    } else if (result.status === "invalid") {
      focusInvalid.current = true; setErrors(result.errors);
    } else if (result.field) {
      focusInvalid.current = true; setErrors(result.errors ?? { [result.field]: [result.message] });
    } else {
      setFormError(result.message);
    }
  }

  return (
    <div ref={formRef}>
      <PasswordPanelView
        values={values} errors={errors} formError={formError} success={success} loading={loading} visible={visible}
        onChange={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
        onToggle={(field) => setVisible((v) => ({ ...v, [field]: !v[field] }))}
        onSubmit={(e) => void onSubmit(e)}
      />
    </div>
  );
}
