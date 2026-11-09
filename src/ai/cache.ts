// Extraction cache in fixtures/extractions/*.json. DEMO_MODE=1 reads only from here.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractRules } from "../engine/schema";
import { extractWithGemini, textHash, type Extraction } from "./extract";

export const isDemoMode = () => process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
const dir = () => join(process.env.C2C_ROOT ?? process.cwd(), "fixtures", "extractions");

export function readCached(name: string): Extraction | null {
  const p = join(dir(), `${name}.json`);
  if (!existsSync(p)) return null;
  const e = JSON.parse(readFileSync(p, "utf8")) as Extraction;
  e.contract = ContractRules.parse(e.contract);
  return e;
}

export function findCachedByText(text: string): Extraction | null {
  const h = textHash(text);
  if (!existsSync(dir())) return null;
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const e = readCached(f.slice(0, -5));
    if (e?.textHash === h) return e;
  }
  return null;
}

export function writeCached(name: string, e: Extraction) {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${name}.json`), JSON.stringify(e, null, 2) + "\n");
}

/**
 * Cached extraction for this exact text if there is one; otherwise call Gemini
 * (refused in DEMO_MODE) and cache the result under `name`.
 */
export async function getExtraction(text: string, name: string, opts: { force?: boolean } = {}): Promise<{ extraction: Extraction; fromCache: boolean }> {
  if (!opts.force) {
    const hit = findCachedByText(text);
    if (hit) return { extraction: hit, fromCache: true };
  }
  if (isDemoMode()) throw new Error(`DEMO_MODE: no cached extraction for "${name}" and live AI calls are disabled.`);
  const extraction = await extractWithGemini(text);
  writeCached(name, extraction);
  return { extraction, fromCache: false };
}
