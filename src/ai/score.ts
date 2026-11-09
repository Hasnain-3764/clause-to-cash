// Compare AI-extracted rules with our hand-checked expected rules.
// Parties are matched by PayPal email (ids may differ), rules by type + party + params.
import { isDeepStrictEqual } from "node:util";
import type { ContractRules, Rule } from "../engine/schema";
import { simulate } from "../engine/simulate";

export interface Score {
  matched: { expected: string; extracted: string }[];
  missing: string[]; // expected rule ids with no match
  extra: string[]; // extracted rule ids with no match
  payoutChecks: { revenueCents: number; same: boolean; expected: Record<string, number>; extracted: Record<string, number> }[];
}

function partyKey(c: ContractRules, partyId: string): string {
  const p = c.parties.find((x) => x.id === partyId);
  return (p?.paypalEmail ?? p?.name ?? partyId).toLowerCase();
}

const sig = (c: ContractRules, r: Rule) => ({ type: r.type, party: partyKey(c, r.party), params: r.params });

export function scoreExtraction(expected: ContractRules, got: ContractRules, revenues: number[], opts: { allMilestonesDone?: boolean } = {}): Score {
  const used = new Set<string>();
  const matched: Score["matched"] = [];
  const missing: string[] = [];
  for (const e of expected.rules) {
    const hit = got.rules.find((g) => !used.has(g.id) && isDeepStrictEqual(sig(expected, e), sig(got, g)));
    if (hit) {
      used.add(hit.id);
      matched.push({ expected: e.id, extracted: hit.id });
    } else missing.push(e.id);
  }
  const extra = got.rules.filter((g) => !used.has(g.id)).map((g) => g.id);

  const payouts = (c: ContractRules, rev: number) => {
    // Milestone names may be worded differently, so "done" means every milestone in that rule set.
    const completedMilestones = opts.allMilestonesDone ? c.rules.flatMap((r) => (r.type === "milestone_payment" ? [r.params.milestone] : [])) : [];
    const s = simulate(c.rules, rev, { parties: c.parties, completedMilestones });
    return Object.fromEntries(s.lines.map((l) => [partyKey(c, l.party), l.amountCents]));
  };
  const payoutChecks = revenues.map((rev) => {
    const a = payouts(expected, rev);
    const b = payouts(got, rev);
    return { revenueCents: rev, same: isDeepStrictEqual(a, b), expected: a, extracted: b };
  });
  return { matched, missing, extra, payoutChecks };
}
