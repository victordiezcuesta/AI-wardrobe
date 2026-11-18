import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { searchCities } from "@/lib/weather/open-meteo";

export const GET = handler("geocode", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`geocode:${userId}`, 120, 600);
  const { q } = z.object({ q: z.string().trim().min(2).max(80) }).parse(Object.fromEntries(new URL(req.url).searchParams));
  return NextResponse.json({ cities: await searchCities(q) });
});
