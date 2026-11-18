import { CloudRain, Thermometer, Wind } from "lucide-react";
import { Card } from "@/components/ui";
import type { WeatherDTO } from "../types";

const t = (n: number | null) => (n == null ? "–" : `${Math.round(n)}°`);

export function WeatherCard({ weather, place }: { weather: WeatherDTO; place: string }) {
  const d = weather.daily;
  return (
    <Card className="flex flex-wrap items-center gap-x-8 gap-y-3 py-5">
      <div>
        <p className="font-display text-4xl leading-none">{t(d.tMin)} / {t(d.tMax)}</p>
        <p className="mt-1 text-sm capitalize text-taupe">{d.description} · {place}</p>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2"><Thermometer className="size-4" aria-hidden /><dt className="sr-only">Sensación</dt><dd>Sensación {t(d.apparentMin)} a {t(d.apparentMax)}</dd></div>
        <div className="flex items-center gap-2"><CloudRain className="size-4" aria-hidden /><dt className="sr-only">Lluvia</dt><dd>Lluvia {d.precipProbMax ?? "–"}%</dd></div>
        <div className="flex items-center gap-2"><Wind className="size-4" aria-hidden /><dt className="sr-only">Viento</dt><dd>Viento {d.windMax == null ? "–" : Math.round(d.windMax)} km/h</dd></div>
      </dl>
    </Card>
  );
}
