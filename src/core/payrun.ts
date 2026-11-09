// Payrun = simulate + policy + approvals for one contract and period, then
// (optionally) submit to PayPal and record everything in the ledger.
import { allowedRecipients } from "../engine/accounts";
import { batchIdempotencyKey } from "../engine/idempotency";
import { sum } from "../engine/money";
import { DEFAULT_APPROVAL_THRESHOLD_CENTS, policy, type PolicyContext, type PolicyResult } from "../engine/policy";
import type { ContractRules } from "../engine/schema";
import { simulate, type PayoutLine, type SimulationResult } from "../engine/simulate";
import { Ledger, rulesHash, type LedgerEntry, type PayoutItemRecord } from "../ledger/ledger";
import { createPayoutBatch, paypalErrorInfo, pollBatch, senderItemId, type BatchStatus, type PayPalFetch } from "../paypal/payouts";

export interface PlanRow {
  line: PayoutLine;
  policy: PolicyResult;
  approved: boolean;
  payable: boolean;
}

export interface Plan {
  contractId: string;
  period: string;
  revenueCents: number;
  simulation: SimulationResult;
  rows: PlanRow[];
  payableLines: { party: string; receiver: string; amountCents: number }[];
  senderBatchId: string | null;
}

export function approvalThreshold(): number {
  const v = Number(process.env.APPROVAL_THRESHOLD_CENTS);
  return Number.isSafeInteger(v) && v > 0 ? v : DEFAULT_APPROVAL_THRESHOLD_CENTS;
}

/** Sum of captured revenue for a contract and period (deduped by capture id). */
export function revenueFor(entries: readonly LedgerEntry[], contractId: string, period: string): { cents: number; captures: string[] } {
  const seen = new Map<string, number>();
  for (const e of entries) if (e.type === "revenue" && e.contractId === contractId && e.period === period) seen.set(e.captureId, e.amountCents);
  return { cents: sum([...seen.values()]), captures: [...seen.keys()] };
}

function isApproved(entries: readonly LedgerEntry[], contractId: string, period: string, l: PayoutLine): boolean {
  return entries.some(
    (e) => e.type === "approval" && e.contractId === contractId && e.period === period && e.party === l.party && e.receiver === l.receiver && e.amountCents === l.amountCents,
  );
}

export function planPayrun(args: {
  contract: ContractRules;
  period: string;
  revenueCents: number;
  completedMilestones?: string[];
  entries?: readonly LedgerEntry[];
  thresholdCents?: number;
  openClauses?: PolicyContext["openClauses"];
}): Plan {
  const { contract, period, revenueCents } = args;
  const entries = args.entries ?? [];
  const simulation = simulate(contract.rules, revenueCents, { parties: contract.parties, completedMilestones: args.completedMilestones });
  const allowed = allowedRecipients();
  const threshold = args.thresholdCents ?? approvalThreshold();
  const rows = simulation.lines.map((line) => {
    const p = policy(line, { rules: contract.rules, simulation, allowedRecipients: allowed, approvalThresholdCents: threshold, openClauses: args.openClauses });
    const approved = p.decision === "needs_approval" && isApproved(entries, contract.contractId, period, line);
    return { line, policy: p, approved, payable: p.decision === "allow" || approved };
  });
  const payableLines = rows.filter((r) => r.payable).map((r) => ({ party: r.line.party, receiver: r.line.receiver!, amountCents: r.line.amountCents }));
  return {
    contractId: contract.contractId,
    period,
    revenueCents,
    simulation,
    rows,
    payableLines,
    senderBatchId: payableLines.length ? batchIdempotencyKey(contract.contractId, period, payableLines) : null,
  };
}

export function approveLine(ledger: Ledger, plan: Plan, party: string, approvedBy: string, note?: string) {
  const row = plan.rows.find((r) => r.line.party === party);
  if (!row) throw new Error(`No payout line for party "${party}"`);
  if (row.policy.decision !== "needs_approval") throw new Error(`Line for "${party}" is ${row.policy.decision}; only needs_approval lines can be approved.`);
  return ledger.append({ type: "approval", contractId: plan.contractId, period: plan.period, party, receiver: row.line.receiver, amountCents: row.line.amountCents, approvedBy, note });
}

export function recordPlan(ledger: Ledger, plan: Plan, contract: ContractRules) {
  const entries = ledger.read();
  const h = rulesHash(contract.rules);
  if (!entries.some((e) => e.type === "rules" && e.contractId === contract.contractId && e.rulesHash === h)) {
    ledger.append({ type: "rules", contractId: contract.contractId, rulesHash: h, rules: contract.rules });
  }
  for (const r of plan.rows) {
    ledger.append({
      type: "decision", contractId: plan.contractId, period: plan.period, party: r.line.party, receiver: r.line.receiver,
      amountCents: r.line.amountCents, decision: r.policy.decision, reasons: r.policy.reasons, approved: r.approved,
    });
  }
}

export type SubmitOutcome =
  | { kind: "submitted"; payoutBatchId: string; final: BatchStatus; settled: boolean }
  | { kind: "duplicate"; outcome: "rejected" | "replayed" | "blocked_locally"; detail: Record<string, unknown> }
  | { kind: "nothing_to_pay" };

function withParty(plan: Plan, items: BatchStatus["items"]): PayoutItemRecord[] {
  return items.map((i) => {
    const line = plan.payableLines.find((l) => senderItemId(plan.senderBatchId!, l.party) === i.senderItemId);
    return { ...i, party: line?.party ?? "?" } as PayoutItemRecord;
  });
}

export async function submitPayrun(
  ledger: Ledger,
  plan: Plan,
  opts: { client?: PayPalFetch; skipLocalGuard?: boolean; requestId?: string; pollIntervalMs?: number; pollTimeoutMs?: number; log?: (s: string) => void } = {},
): Promise<SubmitOutcome> {
  const log = opts.log ?? (() => {});
  if (!plan.senderBatchId) return { kind: "nothing_to_pay" };
  const sbid = plan.senderBatchId;
  const requestId = opts.requestId ?? sbid;
  const before = ledger.read();
  const priorSubmit = before.find((e) => e.type === "payout_submitted" && e.senderBatchId === sbid);
  if (priorSubmit && !opts.skipLocalGuard) {
    ledger.append({ type: "payout_duplicate", contractId: plan.contractId, period: plan.period, senderBatchId: sbid, requestId, outcome: "blocked_locally" });
    return { kind: "duplicate", outcome: "blocked_locally", detail: { reason: "ledger already has this sender_batch_id", payoutBatchId: priorSubmit.type === "payout_submitted" ? priorSubmit.payoutBatchId : undefined } };
  }

  let created;
  try {
    created = await createPayoutBatch({ contractId: plan.contractId, period: plan.period, lines: plan.payableLines }, { client: opts.client, requestId });
  } catch (e) {
    const info = paypalErrorInfo(e);
    if (priorSubmit || /duplicate|already exists|SENDER_BATCH_ID/i.test(`${info.name} ${info.message} ${info.issue}`)) {
      ledger.append({ type: "payout_duplicate", contractId: plan.contractId, period: plan.period, senderBatchId: sbid, requestId, outcome: "rejected", paypal: info });
      return { kind: "duplicate", outcome: "rejected", detail: info };
    }
    throw e;
  }

  if (priorSubmit && priorSubmit.type === "payout_submitted" && priorSubmit.payoutBatchId === created.payoutBatchId) {
    // Same PayPal-Request-Id: PayPal replayed the original response instead of creating a new batch.
    ledger.append({ type: "payout_duplicate", contractId: plan.contractId, period: plan.period, senderBatchId: sbid, requestId, outcome: "replayed", paypal: { payoutBatchId: created.payoutBatchId } });
    return { kind: "duplicate", outcome: "replayed", detail: { payoutBatchId: created.payoutBatchId, batchStatus: created.batchStatus } };
  }

  ledger.append({
    type: "payout_submitted", contractId: plan.contractId, period: plan.period, senderBatchId: sbid, requestId,
    payoutBatchId: created.payoutBatchId, batchStatus: created.batchStatus,
    items: plan.payableLines.map((l) => ({ ...l, senderItemId: senderItemId(sbid, l.party) })),
  });
  log(`submitted payout_batch_id=${created.payoutBatchId} batch_status=${created.batchStatus}`);

  const { status, final } = await pollBatch(created.payoutBatchId, {
    client: opts.client,
    intervalMs: opts.pollIntervalMs,
    timeoutMs: opts.pollTimeoutMs,
    onTick: (s) => log(`  ...batch_status=${s.batchStatus} items=[${s.items.map((i) => i.transactionStatus).join(", ")}]`),
  });
  ledger.append({
    type: "payout_status", contractId: plan.contractId, period: plan.period, senderBatchId: sbid,
    payoutBatchId: created.payoutBatchId, batchStatus: status.batchStatus, final, items: withParty(plan, status.items),
  });
  return { kind: "submitted", payoutBatchId: created.payoutBatchId, final: status, settled: final };
}

/** Re-fetch a batch from PayPal and record its latest state (for batches still pending). */
export async function refreshBatch(ledger: Ledger, plan: Plan, payoutBatchId: string, opts: { client?: PayPalFetch } = {}) {
  const { status, final } = await pollBatch(payoutBatchId, { client: opts.client, timeoutMs: 0 });
  return ledger.append({
    type: "payout_status", contractId: plan.contractId, period: plan.period, senderBatchId: status.senderBatchId,
    payoutBatchId, batchStatus: status.batchStatus, final, items: withParty(plan, status.items),
  });
}

// ---------------------------------------------------------------------------
// Reconciliation: contract-expected vs PayPal-paid, per person.

export type ReconStatus = "matched" | "pending" | "underpaid" | "overpaid" | "blocked" | "awaiting_approval" | "not_sent";

export interface ReconRow {
  party: string;
  receiver: string | null;
  expectedCents: number;
  paidCents: number;
  pendingCents: number;
  diffCents: number; // paid - expected
  status: ReconStatus;
  decision: PolicyResult["decision"];
  payoutBatchIds: string[];
  payoutItemIds: string[];
  transactionIds: string[];
  transactionStatuses: string[];
}

export function reconcile(plan: Plan, entries: readonly LedgerEntry[]): ReconRow[] {
  // Latest status entry per PayPal batch for this contract + period.
  const latest = new Map<string, Extract<LedgerEntry, { type: "payout_status" }>>();
  for (const e of entries) if (e.type === "payout_status" && e.contractId === plan.contractId && e.period === plan.period) latest.set(e.payoutBatchId, e);
  const items = [...latest.values()].flatMap((s) => s.items.map((i) => ({ ...i, payoutBatchId: s.payoutBatchId })));

  return plan.rows.map((r) => {
    const mine = items.filter((i) => i.receiver === r.line.receiver && (i.party === r.line.party || i.party === "?"));
    const paid = sum(mine.filter((i) => i.transactionStatus === "SUCCESS").map((i) => i.amountCents));
    const pending = sum(mine.filter((i) => ["PENDING", "UNCLAIMED", "ONHOLD", "NEW"].includes(i.transactionStatus ?? "") || !i.transactionStatus).map((i) => i.amountCents));
    const expected = r.line.amountCents;
    let status: ReconStatus;
    if (paid === expected) status = "matched";
    else if (paid > expected) status = "overpaid";
    else if (pending > 0) status = "pending";
    else if (paid > 0) status = "underpaid";
    else if (r.policy.decision === "deny") status = "blocked";
    else if (r.policy.decision === "needs_approval" && !r.approved) status = "awaiting_approval";
    else status = "not_sent";
    return {
      party: r.line.party,
      receiver: r.line.receiver,
      expectedCents: expected,
      paidCents: paid,
      pendingCents: pending,
      diffCents: paid - expected,
      status,
      decision: r.policy.decision,
      payoutBatchIds: [...new Set(mine.map((i) => i.payoutBatchId))],
      payoutItemIds: mine.map((i) => i.payoutItemId).filter((x): x is string => !!x),
      transactionIds: mine.map((i) => i.transactionId).filter((x): x is string => !!x),
      transactionStatuses: mine.map((i) => i.transactionStatus ?? "?"),
    };
  });
}
