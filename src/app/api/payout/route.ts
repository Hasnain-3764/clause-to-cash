import { handle } from "@/server/http";
import { sendPayout } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

export const POST = (req: Request) =>
  handle(async () => {
    const { key, period, confirmTotalCents } = (await req.json()) as { key: string; period: string; confirmTotalCents: number };
    return sendPayout(key, period, Number(confirmTotalCents));
  });
