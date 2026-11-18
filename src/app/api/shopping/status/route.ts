import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { shoppingService } from "@/services/shopping.service";

export const GET = handler("shopping.status", async () => {
  await requireUserId();
  return NextResponse.json(await shoppingService.status());
});
