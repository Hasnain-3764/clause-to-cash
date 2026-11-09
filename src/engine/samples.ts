// The three sample contracts we wrote ourselves, plus their hand-checked expected rules.
// Server-side only (reads files).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractRules } from "./schema";

export const SAMPLE_IDS = ["creator-collab", "agency-freelancer", "music-split"] as const;
export type SampleId = (typeof SAMPLE_IDS)[number];

const root = () => process.env.C2C_ROOT ?? process.cwd();

export function loadContractText(id: SampleId): string {
  return readFileSync(join(root(), "contracts", `${id}.txt`), "utf8");
}

export function loadExpectedRules(id: SampleId): ContractRules {
  return ContractRules.parse(JSON.parse(readFileSync(join(root(), "contracts", "expected", `${id}.json`), "utf8")));
}
