import { handle } from "@/server/http";
import { approve } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) =>
  handle(async () => {
    const { key, period, party, approvedBy, note } = (await req.json()) as { key: string; period: string; party: string; approvedBy?: string; note?: string };
    return approve(key, period, party, (approvedBy || "ui reviewer").slice(0, 60), note?.slice(0, 200));
  });
