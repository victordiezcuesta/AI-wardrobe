"use client";
import { useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Download } from "lucide-react";
import { Button, Input, Modal, useToast } from "@/components/ui";
import { api } from "@/utils/api";

export function PrivacyPanel() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function remove() {
    setBusy(true); setError(undefined);
    try {
      await api("/api/account", { method: "DELETE", json: { password } });
      await signOut({ callbackUrl: "/login" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo eliminar la cuenta");
      toast.error("No se ha eliminado la cuenta");
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5 border-t border-stone/50 pt-10" aria-labelledby="privacidad">
      <h2 id="privacidad" className="font-display text-4xl leading-none">Privacidad y datos</h2>
      <p className="max-w-xl text-sm text-taupe">
        Tus fotos personales y las imágenes generadas se guardan en privado y solo las ves tú. Puedes gestionarlas y retirar tu consentimiento en el <Link href="/try-on" className="underline">probador virtual</Link>.
      </p>
      <div className="flex flex-wrap gap-3">
        <a href="/api/account/export" download className="inline-flex h-11 items-center gap-2 rounded-full bg-sand px-6 text-[0.95rem] font-medium transition-colors hover:bg-stone/60"><Download className="size-4" aria-hidden />Descargar mis datos</a>
        <Button variant="ghost" className="text-danger" onClick={() => setOpen(true)}>Eliminar mi cuenta</Button>
      </div>

      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Eliminar cuenta">
        <div className="space-y-4">
          <p className="text-sm">Se borrarán de forma <strong>definitiva</strong> tu perfil, tu armario, tus conjuntos y todas tus fotos e imágenes generadas, también de nuestro almacenamiento. No se puede deshacer.</p>
          <Input label="Tu contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} />
          <Input label="Escribe ELIMINAR para confirmar" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancelar</Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy} disabled={!password || confirm !== "ELIMINAR"}>Eliminar para siempre</Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
