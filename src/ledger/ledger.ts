// Append-only JSONL ledger. Every line is hash-chained to the previous one,
// so editing or deleting a past line is detectable with verifyLedger().
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Reason, Decision } from "../engine/policy";
import type { Rule } from "../engine/schema";

export interface RevenueEntry {
  type: "revenue";
  contractId: string;
  period: string;
  orderId: string;
  captureId: string;
  amountCents: number;
  payerEmail: string | null;
  capturedAt: string;
}
export interface RulesEntry {
  type: "rules";
  contractId: string;
  rulesHash: string;
  rules: Rule[];
}
export interface DecisionEntry {
  type: "decision";
  contractId: string;
  period: string;
  party: string;
  receiver: string | null;
  amountCents: number;
  decision: Decision;
  reasons: Reason[];
  approved: boolean;
}
export interface ApprovalEntry {
  type: "approval";
  contractId: string;
  period: string;
  party: string;
  receiver: string | null;
  amountCents: number;
  approvedBy: string;
  note?: string;
}
export interface PayoutItemRecord {
  party: string;
  receiver: string;
  amountCents: number;
  senderItemId: string;
  payoutItemId?: string;
  transactionId?: string;
  transactionStatus?: string;
  error?: string;
}
export interface PayoutSubmittedEntry {
  type: "payout_submitted";
  contractId: string;
  period: string;
  senderBatchId: string;
  requestId: string;
  payoutBatchId: string;
  batchStatus: string;
  items: PayoutItemRecord[];
}
export interface PayoutDuplicateEntry {
  type: "payout_duplicate";
  contractId: string;
  period: string;
  senderBatchId: string;
  requestId: string;
  outcome: "rejected" | "replayed" | "blocked_locally";
  paypal?: { status?: number; name?: string; message?: string; debugId?: string; payoutBatchId?: string; issue?: string };
}
export interface PayoutStatusEntry {
  type: "payout_status";
  contractId: string;
  period: string;
  senderBatchId: string;
  payoutBatchId: string;
  batchStatus: string;
  final: boolean;
  items: PayoutItemRecord[];
}

export interface RuleReviewEntry {
  type: "rule_review";
  contractId: string;
  ruleId: string;
  status: "proposed" | "confirmed" | "rejected";
  by: string;
}
export interface MilestoneEntry {
  type: "milestone_accepted";
  contractId: string;
  period: string;
  milestone: string;
  accepted: boolean;
  by: string;
}

export type LedgerBody =
  | RuleReviewEntry
  | MilestoneEntry
  | RevenueEntry
  | RulesEntry
  | DecisionEntry
  | ApprovalEntry
  | PayoutSubmittedEntry
  | PayoutDuplicateEntry
  | PayoutStatusEntry;

export type LedgerEntry = LedgerBody & { seq: number; ts: string; prev: string; hash: string };

const GENESIS = "0".repeat(64);

function hashOf(prev: string, body: object): string {
  return createHash("sha256").update(prev).update(JSON.stringify(body)).digest("hex");
}

export class Ledger {
  constructor(readonly path: string) {}

  static default(): Ledger {
    const dir = process.env.DATA_DIR ?? join(process.cwd(), "data");
    return new Ledger(join(dir, "ledger.jsonl"));
  }

  read(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  append<T extends LedgerBody>(body: T, now: Date = new Date()): LedgerEntry {
    const all = this.read();
    const last = all[all.length - 1];
    const meta = { seq: (last?.seq ?? 0) + 1, ts: now.toISOString(), prev: last?.hash ?? GENESIS };
    const unsigned = { ...meta, ...body };
    const entry = { ...unsigned, hash: hashOf(meta.prev, unsigned) } as LedgerEntry;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Returns the seq of the first broken line, or null if the chain is intact. */
  verify(): number | null {
    let prev = GENESIS;
    for (const e of this.read()) {
      const { hash, ...unsigned } = e;
      if (e.prev !== prev || hashOf(prev, unsigned) !== hash) return e.seq;
      prev = hash;
    }
    return null;
  }
}

export function rulesHash(rules: readonly Rule[]): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16);
}
