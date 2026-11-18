"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Button, Skeleton, useToast } from "@/components/ui";
import { api } from "@/utils/api";
import { MAX_ATTEMPTS } from "../constants";
import type { TryOnDTO } from "../types";

const MESSAGES = ["Preparando tu foto y las prendas…", "Vistiéndote con el conjunto…", "Ajustando luz y fondo…", "Retocando los detalles…", "Casi listo, esto puede tardar un minuto…"];

/** Sondea el estado de un trabajo hasta que termina. El proveedor no informa de porcentaje: se muestra tiempo transcurrido. */
export function JobCard({ job, onUpdate }: { job: TryOnDTO; onUpdate: (j: TryOnDTO) => void }) {
  const toast = useToast();
  const [seconds, setSeconds] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const active = job.status === "PENDING" || job.status === "PROCESSING";

  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    const poll = setInterval(async () => {
      try { onUpdate((await api<{ image: TryOnDTO }>(`/api/try-on/${job.id}`)).image); } catch { /* se reintenta en el siguiente ciclo */ }
    }, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [active, job.id, onUpdate]);

  async function retry() {
    setRetrying(true);
    try { setSeconds(0); onUpdate((await api<{ image: TryOnDTO }>(`/api/try-on/${job.id}/retry`, { method: "POST" })).image); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo reintentar"); }
    finally { setRetrying(false); }
  }

  if (active) {
    return (
      <div className="grid gap-6 rounded-card bg-linen p-6 sm:grid-cols-[14rem_1fr]" role="status" aria-live="polite">
        <Skeleton className="aspect-[3/4] w-full" />
        <div className="flex flex-col justify-center gap-3">
          <p className="flex items-center gap-2 font-display text-3xl"><Loader2 className="size-5 animate-spin" aria-hidden />{MESSAGES[Math.min(MESSAGES.length - 1, Math.floor(seconds / 12))]}</p>
          <p className="text-sm text-taupe">{seconds} s · Puedes salir de esta página: la imagen aparecerá en tu historial.</p>
        </div>
      </div>
    );
  }
  if (job.status === "FAILED") {
    return (
      <div className="rounded-card bg-linen p-6" role="alert">
        <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" aria-hidden />No se ha podido generar la imagen</p>
        <p className="mt-1 text-sm text-taupe">{job.errorMessage ?? "Error desconocido"}</p>
        {job.attempts < MAX_ATTEMPTS
          ? <Button className="mt-4" variant="secondary" size="sm" onClick={() => void retry()} loading={retrying}><RotateCcw className="size-4" aria-hidden />Reintentar ({MAX_ATTEMPTS - job.attempts} {MAX_ATTEMPTS - job.attempts === 1 ? "intento" : "intentos"})</Button>
          : <p className="mt-3 text-sm">Has agotado los intentos de esta imagen. Prueba con otra foto o escenario.</p>}
      </div>
    );
  }
  return null;
}
