// policy(line) -> allow | needs_approval | deny, with reason codes.
// Precedence: deny > needs_approval > allow. All reasons found are returned.
import { formatUSD, sum } from "./money";
import type { Rule } from "./schema";
import type { PayoutLine, SimulationResult } from "./simulate";

export type Decision = "allow" | "needs_approval" | "deny";

export type DenyCode = "PAYOUTS_EXCEED_REVENUE" | "RECIPIENT_NOT_ALLOWED" | "RULE_REJECTED" | "RULE_MISSING" | "INVALID_AMOUNT";
export type ApprovalCode = "LOW_CONFIDENCE" | "OVER_THRESHOLD" | "CONFLICTING_RULES" | "UNMODELED_CLAUSE";
export type ReasonCode = DenyCode | ApprovalCode;

export interface Reason {
  code: ReasonCode;
  detail: string;
}

export interface PolicyResult {
  decision: Decision;
  reasons: Reason[];
}

export interface PolicyContext {
  /** Current rules (the line may have been simulated against an older copy). */
  rules: readonly Rule[];
  simulation: Pick<SimulationResult, "revenueCents" | "reserveCents" | "lines">;
  /** Payout recipients allowed by config/accounts.json. */
  allowedRecipients: ReadonlySet<string> | readonly string[];
  approvalThresholdCents: number;
  lowConfidence?: number; // default 0.7
  /** Contract clauses that affect payments but are not encoded as rules (party null = everyone). */
  openClauses?: readonly { id: string; party: string | null; reason: string }[];
}

export const DEFAULT_APPROVAL_THRESHOLD_CENTS = 100_000; // $1,000.00
const DENY: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["PAYOUTS_EXCEED_REVENUE", "RECIPIENT_NOT_ALLOWED", "RULE_REJECTED", "RULE_MISSING", "INVALID_AMOUNT"]);

export function policy(line: PayoutLine, ctx: PolicyContext): PolicyResult {
  const reasons: Reason[] = [];
  const allowed = ctx.allowedRecipients instanceof Set ? ctx.allowedRecipients : new Set(ctx.allowedRecipients as readonly string[]);
  const lowConf = ctx.lowConfidence ?? 0.7;
  const rulesById = new Map(ctx.rules.map((r) => [r.id, r]));

  // --- deny ---
  const paid = sum(ctx.simulation.lines.map((l) => l.amountCents)) + ctx.simulation.reserveCents;
  if (paid > ctx.simulation.revenueCents || line.amountCents > ctx.simulation.revenueCents) {
    reasons.push({ code: "PAYOUTS_EXCEED_REVENUE", detail: `Payouts + reserve (${formatUSD(paid)}) exceed revenue (${formatUSD(ctx.simulation.revenueCents)}).` });
  }
  if (!line.receiver || !allowed.has(line.receiver)) {
    reasons.push({ code: "RECIPIENT_NOT_ALLOWED", detail: line.receiver ? `${line.receiver} is not in config/accounts.json.` : `No PayPal email for party "${line.party}".` });
  }
  if (!Number.isSafeInteger(line.amountCents) || line.amountCents <= 0) {
    reasons.push({ code: "INVALID_AMOUNT", detail: `Amount ${line.amountCents} cents is not a positive whole number of cents.` });
  }
  for (const id of line.ruleIds) {
    const r = rulesById.get(id);
    if (!r) reasons.push({ code: "RULE_MISSING", detail: `Rule ${id} no longer exists.` });
    else if (r.status === "rejected") reasons.push({ code: "RULE_REJECTED", detail: `Rule ${id} was rejected.` });
  }

  // --- needs approval ---
  for (const id of line.ruleIds) {
    const r = rulesById.get(id);
    if (r && r.status !== "confirmed" && r.confidence < lowConf) {
      reasons.push({ code: "LOW_CONFIDENCE", detail: `Rule ${id} has confidence ${r.confidence.toFixed(2)} and is not confirmed.` });
    }
  }
  if (line.amountCents > ctx.approvalThresholdCents) {
    reasons.push({ code: "OVER_THRESHOLD", detail: `${formatUSD(line.amountCents)} is over the ${formatUSD(ctx.approvalThresholdCents)} approval threshold.` });
  }
  for (const c of ctx.openClauses ?? []) {
    if (c.party === null || c.party === line.party) {
      reasons.push({ code: "UNMODELED_CLAUSE", detail: `Clause ${c.id} is not encoded as a rule: ${c.reason}` });
    }
  }
  if (line.conflicts.length) {
    reasons.push({ code: "CONFLICTING_RULES", detail: `Conflicts: ${line.conflicts.join(", ")}.` });
  }

  const decision: Decision = reasons.some((r) => DENY.has(r.code)) ? "deny" : reasons.length ? "needs_approval" : "allow";
  reasons.sort((a, b) => Number(DENY.has(b.code)) - Number(DENY.has(a.code)) || a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
  return { decision, reasons };
}
