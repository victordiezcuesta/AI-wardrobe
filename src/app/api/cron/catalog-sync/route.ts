import { NextResponse } from "next/server";
import { AppError, handler } from "@/lib/errors";
import { isAuthorizedCron } from "@/lib/auth/cron";
import { catalogSyncService } from "@/services/catalog-sync.service";

export const maxDuration = 300;

export const GET = handler("cron.catalog", async (req: Request) => {
  if (!isAuthorizedCron(req)) throw new AppError("No autorizado", 401, "UNAUTHORIZED");
  const out = await catalogSyncService.syncAll({ budgetMs: 240_000 });
  return NextResponse.json(out);
});
