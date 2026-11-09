import { handle } from "@/server/http";
import { loadContract, setMilestone } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) =>
  handle(async () => {
    const { key, period, milestone, accepted } = (await req.json()) as { key: string; period: string; milestone: string; accepted: boolean };
    const c = await loadContract(key);
    if (!c.contract.rules.some((r) => r.type === "milestone_payment" && r.params.milestone === milestone)) throw new Error("Unknown milestone");
    setMilestone(c.contract.contractId, period, milestone, !!accepted);
    return { ok: true };
  });
