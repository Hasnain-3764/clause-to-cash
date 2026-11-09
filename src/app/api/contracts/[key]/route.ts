import { handle } from "@/server/http";
import { loadContract } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request, ctx: { params: Promise<{ key: string }> }) =>
  handle(async () => loadContract((await ctx.params).key, { force: new URL(req.url).searchParams.get("force") === "1" }));
