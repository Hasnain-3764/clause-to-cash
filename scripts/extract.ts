// Extract payment rules from the sample contracts with Gemini, cache them, and
// score them against our hand-checked expected rules.
//
//   npm run extract                      all samples (uses cache when the text is unchanged)
//   npm run extract -- --contract music-split --force   re-run the model even if cached
//   DEMO_MODE=1 npm run extract          cache only, no API key needed
import "dotenv/config";
import { parseArgs } from "node:util";
import { getExtraction } from "../src/ai/cache";
import { scoreExtraction } from "../src/ai/score";
import { formatUSD } from "../src/engine/money";
import { SAMPLE_IDS, loadContractText, loadExpectedRules, type SampleId } from "../src/engine/samples";
import type { Rule } from "../src/engine/schema";

const { values } = parseArgs({ options: { contract: { type: "string", default: "all" }, force: { type: "boolean", default: false } } });
const ids: SampleId[] = values.contract === "all" ? [...SAMPLE_IDS] : [values.contract as SampleId];
const REVENUES = [80_000, 400_000, 800_000, 2_500_000];

function describe(r: Rule): string {
  const pct = (b: number) => `${b / 100}%`;
  switch (r.type) {
    case "percentage_split": return pct(r.params.basisPoints);
    case "tiered_split": return r.params.tiers.map((t) => `${pct(t.basisPoints)}${t.upToCents === null ? "+" : `≤${formatUSD(t.upToCents)}`}`).join(" / ");
    case "milestone_payment": return `${formatUSD(r.params.amountCents)} on "${r.params.milestone}"`;
    case "cap_minimum": return `${r.params.kind} ${formatUSD(r.params.amountCents)}`;
    case "reserve_clawback": return r.params.kind === "reserve" ? `reserve ${pct(r.params.basisPoints)} for ${r.params.releaseAfterDays}d` : `clawback ${pct(r.params.basisPoints)} of ${formatUSD(r.params.outstandingCents)}`;
  }
}

let failures = 0;
for (const id of ids) {
  if (!SAMPLE_IDS.includes(id)) throw new Error(`unknown contract ${id}`);
  const text = loadContractText(id);
  const t0 = Date.now();
  const { extraction: x, fromCache } = await getExtraction(text, id, { force: values.force });
  console.log(`\n=== ${id} (${x.contractId}) ${fromCache ? "[CACHED]" : `[LIVE ${x.model}, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${x.usage?.inputTokens ?? "?"} in / ${x.usage?.outputTokens ?? "?"} out tokens]`}`);
  console.log(`payer: ${x.contract.payer}`);
  for (const p of x.contract.parties) console.log(`  party ${p.id.padEnd(12)} ${p.name.padEnd(16)} ${p.paypalEmail ?? "(no email)"}`);
  for (const r of x.contract.rules) {
    console.log(`  ${r.id.padEnd(4)}${r.type.padEnd(18)}${r.party.padEnd(12)}${describe(r).padEnd(42)} conf ${r.confidence.toFixed(2)}  p${r.source.page}`);
    console.log(`      "${r.source.quote.replace(/\s+/g, " ").slice(0, 110)}${r.source.quote.length > 110 ? "…" : ""}"`);
  }
  for (const u of x.unmodeled ?? []) console.log(`  UNMODELED ${u.id} (${u.party ?? "everyone"}${u.verified ? "" : ", QUOTE NOT FOUND"}): "${u.quote.replace(/\s+/g, " ").slice(0, 90)}" -> ${u.reason}`);
  for (const f of x.flags) console.log(`  FLAG ${f.code} ${f.ruleId ?? ""}: ${f.message}`);

  const s = scoreExtraction(loadExpectedRules(id), x.contract, REVENUES, { allMilestonesDone: true });
  const exp = loadExpectedRules(id).rules.length;
  console.log(`  score: ${s.matched.length}/${exp} expected rules matched exactly; missing [${s.missing.join(", ")}]; extra [${s.extra.join(", ")}]`);
  for (const c of s.payoutChecks) {
    console.log(`  payouts @ ${formatUSD(c.revenueCents).padStart(10)}: ${c.same ? "IDENTICAL to hand-checked rules" : `DIFFERENT expected=${JSON.stringify(c.expected)} got=${JSON.stringify(c.extracted)}`}`);
  }
  if (s.payoutChecks.some((c) => !c.same) || x.flags.some((f) => f.code === "QUOTE_NOT_FOUND")) failures++;
}
process.exitCode = failures ? 1 : 0;
