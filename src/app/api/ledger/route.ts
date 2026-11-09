import { handle } from "@/server/http";
import { ledgerView } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handle(async () => ledgerView(new URL(req.url).searchParams.get("contractId") ?? undefined));
