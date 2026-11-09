import { handle } from "@/server/http";
import { loadContract, reviewRule } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request, ctx: { params: Promise<{ key: string }> }) =>
  handle(async () => {
    const { ruleId, status } = (await req.json()) as { ruleId: string; status: "proposed" | "confirmed" | "rejected" };
    if (!["proposed", "confirmed", "rejected"].includes(status)) throw new Error("bad status");
    const c = await loadContract((await ctx.params).key);
    if (!c.contract.rules.some((r) => r.id === ruleId)) throw new Error(`No rule ${ruleId}`);
    reviewRule(c.contract.contractId, ruleId, status);
    return { ok: true };
  });
