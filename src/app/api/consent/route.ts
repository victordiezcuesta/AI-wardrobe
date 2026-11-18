import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { consentService } from "@/services/consent.service";

export const GET = handler("consent.get", async () => NextResponse.json(await consentService.status(await requireUserId())));

export const POST = handler("consent.set", async (req: Request) => {
  const userId = await requireUserId();
  const { granted } = z.object({ granted: z.boolean() }).parse(await req.json());
  return NextResponse.json(await consentService.set(userId, granted));
});
