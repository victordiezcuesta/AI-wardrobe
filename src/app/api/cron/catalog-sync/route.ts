import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { AppError, handler } from "@/lib/errors";
import { env } from "@/lib/env";
import { catalogSyncService } from "@/services/catalog-sync.service";

export const maxDuration = 300;

/** Vercel Cron envía "Authorization: Bearer $CRON_SECRET" cuando CRON_SECRET está definido en el proyecto. */
function authorized(req: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export const GET = handler("cron.catalog", async (req: Request) => {
  if (!authorized(req)) throw new AppError("No autorizado", 401, "UNAUTHORIZED");
  const out = await catalogSyncService.syncAll({ budgetMs: 240_000 });
  return NextResponse.json(out);
});
