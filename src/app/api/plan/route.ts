import { handle } from "@/server/http";
import { buildPlan, type PlanInput } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handle(async () => buildPlan((await req.json()) as PlanInput));
