import { handler } from "@/lib/errors";
import { requireUserId } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { accountService } from "@/services/account.service";

export const GET = handler("account.export", async () => {
  const userId = await requireUserId();
  await rateLimit(`account-export:${userId}`, 5, 3600);
  const data = await accountService.export(userId);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ai-wardrobe-mis-datos.json"',
      "Cache-Control": "no-store",
    },
  });
});
