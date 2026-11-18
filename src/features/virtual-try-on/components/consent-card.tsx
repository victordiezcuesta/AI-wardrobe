"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Card, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import type { ConsentDTO } from "../types";

export function ConsentCard({ consent, onChange }: { consent: ConsentDTO; onChange: (c: ConsentDTO) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function set(granted: boolean) {
    setBusy(true);
    try { onChange(await api<ConsentDTO>("/api/consent", { method: "POST", json: { granted } })); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo guardar tu decisión"); }
    finally { setBusy(false); }
  }

  if (consent.granted) {
    return (
      <p className="flex flex-wrap items-center gap-3 text-sm text-taupe">
        <ShieldCheck className="size-4" aria-hidden />Has autorizado el uso de tus fotos para el probador.
        <button type="button" onClick={() => void set(false)} disabled={busy} className="underline">Retirar consentimiento</button>
      </p>
    );
  }
  return (
    <Card className="max-w-2xl space-y-4">
      <h2 className="font-display text-3xl">Antes de empezar: tus fotos</h2>
      <p>Para mostrarte con cada conjunto necesitamos usar una foto tuya. Esto es lo que pasa con ella:</p>
      <ul className="list-disc space-y-1.5 pl-5 text-sm">
        <li>Se guarda <strong>privada</strong> en Cloudinary, sin enlace público; solo tú la ves mediante enlaces temporales.</li>
        <li>Al generar una imagen, tu foto y las fotos de las prendas se envían a <strong>Pollinations.ai</strong>, el servicio que crea la imagen. No se envían a ningún otro proveedor de IA.</li>
        <li>Puedes borrar tus fotos y las imágenes generadas cuando quieras, y retirar este consentimiento en cualquier momento.</li>
        <li>El resultado es una <strong>recreación hecha con IA</strong>: puede no conservar tu rostro ni los detalles de las prendas con exactitud.</li>
      </ul>
      <Button onClick={() => void set(true)} loading={busy}>Acepto el uso de mis fotos</Button>
    </Card>
  );
}
