import { handle } from "@/server/http";
import { refresh } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) =>
  handle(async () => {
    const { key, period, payoutBatchId } = (await req.json()) as { key: string; period: string; payoutBatchId: string };
    return refresh(key, period, payoutBatchId);
  });
