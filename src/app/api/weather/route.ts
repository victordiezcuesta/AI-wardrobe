import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { weatherService } from "@/services/weather.service";

const query = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GET = handler("weather", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`weather:${userId}`, 120, 600);
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return NextResponse.json({ weather: await weatherService.getForecast(q.lat, q.lon, q.date) });
});
