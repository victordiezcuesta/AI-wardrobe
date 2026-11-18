import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { profileSchema } from "@/lib/validations/profile";
import { profileService } from "@/services/profile.service";
import { rateLimit } from "@/lib/rate-limit";

export const GET = handler("profile.get", async () => {
  const userId = await requireUserId();
  return NextResponse.json({ profile: await profileService.get(userId) });
});

export const PUT = handler("profile.put", async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit(`profile:${userId}`, 60, 3600);
  const input = profileSchema.parse(await req.json());
  return NextResponse.json({ profile: await profileService.save(userId, input) });
});
