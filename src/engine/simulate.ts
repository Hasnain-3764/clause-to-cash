// simulate(rules, revenueCents) -> who gets paid what this period.
//
// Order of operations (all integer cents):
//   1. Completed milestones are paid first, in rule order, from gross revenue.
//   2. Percentage and tiered shares are computed on gross revenue. They are
//      rounded with largest-remainder against what is left after milestones,
//      so shares + retained sum exactly. If shares + milestones would exceed
//      revenue, shares are scaled down pro rata (OVERALLOCATED conflict).
//   3. Minimums top a party up from the payer's retained amount.
//   4. Caps cut a party down; the excess goes back to retained. Caps run after
//      minimums so a cap is never breached.
//   5. Clawbacks recoup from the party's total into retained.
//   6. Reserves hold back part of the party's total into the reserve.
// Invariant: sum(lines) + reserveCents + retainedCents === revenueCents.
import { allocate, bpsOf, formatUSD, sum } from "./money";
import type { Party, Rule } from "./schema";

export type WarningCode =
  | "OVERALLOCATED"
  | "SHARES_EXCEED_100_PERCENT"
  | "CONFLICT_MULTIPLE_SHARES"
  | "CONFLICT_DUPLICATE_LIMIT"
  | "CONFLICT_MIN_ABOVE_CAP"
  | "MILESTONE_SHORTFALL"
  | "MINIMUM_SHORTFALL"
  | "CAP_APPLIED"
  | "MINIMUM_APPLIED"
  | "CLAWBACK_APPLIED"
  | "RESERVE_HELD"
  | "UNKNOWN_PARTY";

const CONFLICT_CODES: ReadonlySet<WarningCode> = new Set([
  "OVERALLOCATED",
  "SHARES_EXCEED_100_PERCENT",
  "CONFLICT_MULTIPLE_SHARES",
  "CONFLICT_DUPLICATE_LIMIT",
  "CONFLICT_MIN_ABOVE_CAP",
]);

export interface Warning {
  code: WarningCode;
  severity: "info" | "warning" | "conflict";
  party?: string;
  ruleIds: string[];
  message: string;
}

export interface BreakdownEntry {
  ruleId: string;
  type: Rule["type"];
  deltaCents: number; // signed effect of this rule on the party's payout
  note: string;
}

export interface PayoutLine {
  party: string;
  receiver: string | null; // PayPal email, from the parties list
  amountCents: number; // what is actually paid now
  grossCents: number; // before clawback and reserve
  reserveCents: number;
  recoupedCents: number;
  ruleIds: string[]; // every active rule that targets this party
  conflicts: WarningCode[];
  breakdown: BreakdownEntry[];
}

export interface SimulationResult {
  revenueCents: number;
  lines: PayoutLine[];
  reserveCents: number;
  retainedCents: number; // kept by the payer (includes recouped clawbacks)
  recoupedCents: number;
  warnings: Warning[];
}

export interface SimulateOptions {
  parties?: Party[];
  completedMilestones?: string[];
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** Exact share numerator in cents * 10000 (bps denominator) for a share rule. */
function shareNumerator(rule: Rule, revenueCents: number): bigint {
  const rev = BigInt(revenueCents);
  if (rule.type === "percentage_split") return rev * BigInt(rule.params.basisPoints);
  if (rule.type === "tiered_split") {
    let acc = 0n;
    let prev = 0n;
    for (const t of rule.params.tiers) {
      const top = t.upToCents === null ? rev : BigInt(Math.min(t.upToCents, revenueCents));
      if (top > prev) acc += (top - prev) * BigInt(t.basisPoints);
      if (t.upToCents !== null) prev = BigInt(t.upToCents);
      if (t.upToCents === null || t.upToCents >= revenueCents) break;
    }
    return acc;
  }
  return 0n;
}

function maxBps(rule: Rule): number {
  if (rule.type === "percentage_split") return rule.params.basisPoints;
  if (rule.type === "tiered_split") return Math.max(...rule.params.tiers.map((t) => t.basisPoints));
  return 0;
}

export function simulate(rules: readonly Rule[], revenueCents: number, opts: SimulateOptions = {}): SimulationResult {
  if (!Number.isSafeInteger(revenueCents) || revenueCents < 0) throw new Error(`bad revenue ${revenueCents}`);
  const active = rules.filter((r) => r.status !== "rejected");
  const completed = new Set(opts.completedMilestones ?? []);
  const partyEmail = new Map((opts.parties ?? []).map((p) => [p.id, p.paypalEmail]));
  const warnings: Warning[] = [];
  const warn = (w: Warning) => warnings.push(w);

  // Parties in order of first appearance.
  const partyOrder: string[] = [];
  for (const r of active) if (!partyOrder.includes(r.party)) partyOrder.push(r.party);
  const byParty = (p: string) => active.filter((r) => r.party === p);

  const total = new Map<string, number>(partyOrder.map((p) => [p, 0]));
  const breakdown = new Map<string, BreakdownEntry[]>(partyOrder.map((p) => [p, []]));
  const conflicts = new Map<string, Set<WarningCode>>(partyOrder.map((p) => [p, new Set()]));
  const flag = (party: string, code: WarningCode) => conflicts.get(party)!.add(code);
  const add = (party: string, rule: Rule, delta: number, note: string) => {
    total.set(party, total.get(party)! + delta);
    breakdown.get(party)!.push({ ruleId: rule.id, type: rule.type, deltaCents: delta, note });
  };

  // --- Structural conflicts -------------------------------------------------
  for (const p of partyOrder) {
    const rs = byParty(p);
    if (opts.parties && !partyEmail.has(p)) {
      warn({ code: "UNKNOWN_PARTY", severity: "warning", party: p, ruleIds: rs.map((r) => r.id), message: `Party "${p}" is not in the contract's parties list.` });
    }
    const shares = rs.filter((r) => r.type === "percentage_split" || r.type === "tiered_split");
    if (shares.length > 1) {
      flag(p, "CONFLICT_MULTIPLE_SHARES");
      warn({ code: "CONFLICT_MULTIPLE_SHARES", severity: "conflict", party: p, ruleIds: shares.map((r) => r.id), message: `${p} has ${shares.length} revenue-share rules; they are added together. Check which one the contract means.` });
    }
    const limits = rs.filter((r) => r.type === "cap_minimum");
    const caps = limits.filter((r) => r.params.kind === "cap");
    const mins = limits.filter((r) => r.params.kind === "minimum");
    for (const group of [caps, mins]) {
      if (new Set(group.map((r) => r.params.amountCents)).size > 1) {
        flag(p, "CONFLICT_DUPLICATE_LIMIT");
        warn({ code: "CONFLICT_DUPLICATE_LIMIT", severity: "conflict", party: p, ruleIds: group.map((r) => r.id), message: `${p} has ${group.length} different ${group[0].params.kind} amounts; the strictest is used.` });
      }
    }
    const holds = rs.filter((r) => r.type === "reserve_clawback");
    for (const kind of ["reserve", "clawback"] as const) {
      const g = holds.filter((r) => r.params.kind === kind);
      if (g.length > 1) {
        flag(p, "CONFLICT_DUPLICATE_LIMIT");
        warn({ code: "CONFLICT_DUPLICATE_LIMIT", severity: "conflict", party: p, ruleIds: g.map((r) => r.id), message: `${p} has ${g.length} ${kind} rules; each is applied in turn.` });
      }
    }
    if (caps.length && mins.length) {
      const cap = Math.min(...caps.map((r) => r.params.amountCents));
      const min = Math.max(...mins.map((r) => r.params.amountCents));
      if (min > cap) {
        flag(p, "CONFLICT_MIN_ABOVE_CAP");
        warn({ code: "CONFLICT_MIN_ABOVE_CAP", severity: "conflict", party: p, ruleIds: [...caps, ...mins].map((r) => r.id), message: `${p}'s minimum is above its cap; the cap wins.` });
      }
    }
  }
  const shareRules = active.filter((r) => r.type === "percentage_split" || r.type === "tiered_split");
  const totalMaxBps = sum(shareRules.map(maxBps));
  if (totalMaxBps > 10_000) {
    for (const r of shareRules) flag(r.party, "SHARES_EXCEED_100_PERCENT");
    warn({ code: "SHARES_EXCEED_100_PERCENT", severity: "conflict", ruleIds: shareRules.map((r) => r.id), message: `Revenue shares can add up to ${pct(totalMaxBps)} of revenue.` });
  }

  // --- 1. Milestones --------------------------------------------------------
  let remaining = revenueCents;
  const milestoneRules = active.filter((r) => r.type === "milestone_payment");
  for (const r of milestoneRules) {
    if (r.type !== "milestone_payment" || !completed.has(r.params.milestone)) continue;
    const owed = r.params.amountCents;
    const paid = Math.min(owed, remaining);
    remaining -= paid;
    add(r.party, r, paid, `Milestone "${r.params.milestone}" completed`);
    if (paid < owed) {
      warn({ code: "MILESTONE_SHORTFALL", severity: "warning", party: r.party, ruleIds: [r.id], message: `Only ${formatUSD(paid)} of ${formatUSD(owed)} available for milestone "${r.params.milestone}".` });
    }
  }

  // --- 2. Shares --------------------------------------------------------------
  const nums = shareRules.map((r) => shareNumerator(r, revenueCents));
  const S = nums.reduce((a, b) => a + b, 0n);
  const availScaled = BigInt(remaining) * 10_000n;
  let shareParts: number[];
  let retained: number;
  if (S <= availScaled) {
    const parts = allocate(remaining, [...nums, availScaled - S]);
    retained = parts.pop()!;
    shareParts = parts;
  } else {
    shareParts = allocate(remaining, [...nums, 0n]);
    retained = shareParts.pop()!; // always 0 here
    const ids = [...shareRules.map((r) => r.id), ...milestoneRules.map((r) => r.id)];
    for (const r of shareRules) flag(r.party, "OVERALLOCATED");
    for (const r of milestoneRules) flag(r.party, "OVERALLOCATED");
    warn({ code: "OVERALLOCATED", severity: "conflict", ruleIds: ids, message: "Milestones and shares add up to more than revenue; shares were scaled down pro rata." });
  }
  shareRules.forEach((r, i) => {
    const note = r.type === "percentage_split"
      ? `${pct(r.params.basisPoints)} of revenue`
      : `Tiered share (${r.type === "tiered_split" ? r.params.tiers.map((t) => `${pct(t.basisPoints)}${t.upToCents === null ? " above" : ` to $${t.upToCents / 100}`}`).join(", ") : ""})`;
    add(r.party, r, shareParts[i], note);
  });

  // --- 3. Minimums, 4. Caps, 5. Clawbacks, 6. Reserves -----------------------
  let reserveCents = 0;
  let recoupedCents = 0;
  const holds = new Map<string, { reserve: number; recouped: number; gross: number }>();
  for (const p of partyOrder) {
    const rs = byParty(p);
    const mins = rs.filter((r): r is Extract<Rule, { type: "cap_minimum" }> => r.type === "cap_minimum" && r.params.kind === "minimum");
    const caps = rs.filter((r): r is Extract<Rule, { type: "cap_minimum" }> => r.type === "cap_minimum" && r.params.kind === "cap");
    if (mins.length) {
      const r = mins.reduce((a, b) => (b.params.amountCents > a.params.amountCents ? b : a));
      const want = r.params.amountCents - total.get(p)!;
      if (want > 0) {
        const topUp = Math.min(want, retained);
        retained -= topUp;
        add(p, r, topUp, `Topped up to minimum`);
        warn({ code: topUp < want ? "MINIMUM_SHORTFALL" : "MINIMUM_APPLIED", severity: topUp < want ? "warning" : "info", party: p, ruleIds: [r.id], message: topUp < want ? `Minimum not fully met: ${formatUSD(want - topUp)} short.` : `Topped up by ${formatUSD(topUp)} to meet the ${formatUSD(r.params.amountCents)} minimum.` });
      }
    }
    if (caps.length) {
      const r = caps.reduce((a, b) => (b.params.amountCents < a.params.amountCents ? b : a));
      const excess = total.get(p)! - r.params.amountCents;
      if (excess > 0) {
        retained += excess;
        add(p, r, -excess, `Capped`);
        warn({ code: "CAP_APPLIED", severity: "info", party: p, ruleIds: [r.id], message: `Cut by ${formatUSD(excess)} to respect the ${formatUSD(r.params.amountCents)} cap.` });
      }
    }
    const gross = total.get(p)!;
    let recouped = 0;
    let reserve = 0;
    for (const r of rs) {
      if (r.type !== "reserve_clawback") continue;
      const cur = total.get(p)!;
      if (r.params.kind === "clawback") {
        const amt = Math.min(r.params.outstandingCents, bpsOf(cur, r.params.basisPoints));
        if (amt > 0) {
          retained += amt;
          recouped += amt;
          add(p, r, -amt, `Clawback: ${pct(r.params.basisPoints)} until advance recouped`);
          warn({ code: "CLAWBACK_APPLIED", severity: "info", party: p, ruleIds: [r.id], message: `Recouped ${formatUSD(amt)} of the advance; ${formatUSD(r.params.outstandingCents - amt)} still outstanding.` });
        }
      } else {
        const amt = bpsOf(cur, r.params.basisPoints);
        if (amt > 0) {
          reserve += amt;
          add(p, r, -amt, `Reserve: ${pct(r.params.basisPoints)} held ${r.params.releaseAfterDays} days`);
          warn({ code: "RESERVE_HELD", severity: "info", party: p, ruleIds: [r.id], message: `Held ${formatUSD(amt)} in reserve for ${r.params.releaseAfterDays} days.` });
        }
      }
    }
    reserveCents += reserve;
    recoupedCents += recouped;
    holds.set(p, { reserve, recouped, gross });
  }

  const lines: PayoutLine[] = partyOrder
    .map((p) => ({
      party: p,
      receiver: partyEmail.get(p) ?? null,
      amountCents: total.get(p)!,
      grossCents: holds.get(p)!.gross,
      reserveCents: holds.get(p)!.reserve,
      recoupedCents: holds.get(p)!.recouped,
      ruleIds: byParty(p).map((r) => r.id),
      conflicts: [...conflicts.get(p)!].filter((c) => CONFLICT_CODES.has(c)).sort(),
      breakdown: breakdown.get(p)!,
    }))
    .filter((l) => l.amountCents > 0);

  return { revenueCents, lines, reserveCents, retainedCents: retained, recoupedCents, warnings };
}

/** The "naive" comparison: revenue split equally between every payee party. */
export function naiveEqualSplit(revenueCents: number, partyIds: readonly string[]): Map<string, number> {
  const parts = allocate(revenueCents, partyIds.map(() => 1n));
  return new Map(partyIds.map((p, i) => [p, parts[i]]));
}
