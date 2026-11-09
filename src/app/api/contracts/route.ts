import { isDemoMode } from "@/ai/cache";
import { handle } from "@/server/http";
import { addUpload, listContracts } from "@/server/state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => handle(async () => ({ contracts: listContracts(), demoMode: isDemoMode(), model: process.env.GEMINI_MODEL ?? null }));

export const POST = (req: Request) =>
  handle(async () => {
    const { text } = (await req.json()) as { text?: string };
    return { key: await addUpload(String(text ?? "")) };
  });
