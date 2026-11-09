// PayPal Payouts adapter (sandbox only; all HTTP goes through scripts/lib/paypal.ts).
// Idempotency: sender_batch_id = hash(contractId, period, sorted lines), and the
// same value is sent as the PayPal-Request-Id header.
import { batchIdempotencyKey } from "../engine/idempotency";
import { centsToValue, valueToCents } from "../engine/money";
import type { PayoutItemRecord } from "../ledger/ledger";

export type PayPalFetch = <T = any>(path: string, init?: RequestInit) => Promise<T>;

/** Loaded lazily so importing this file never triggers the sandbox guard's process.exit. */
export async function defaultClient(): Promise<PayPalFetch> {
  const m = await import("../../scripts/lib/paypal.ts");
  return m.paypalFetch;
}

export interface BatchLine {
  party: string;
  receiver: string;
  amountCents: number;
}

export interface PayoutBatchRequest {
  contractId: string;
  period: string;
  lines: BatchLine[];
  note?: string;
}

export function senderItemId(senderBatchId: string, party: string): string {
  // PayPal limits sender_item_id to 63 chars.
  return `${party.slice(0, 30)}-${senderBatchId.slice(4, 20)}`;
}

export function buildPayoutBody(req: PayoutBatchRequest) {
  const senderBatchId = batchIdempotencyKey(req.contractId, req.period, req.lines);
  const lines = [...req.lines].sort((a, b) => (a.receiver < b.receiver ? -1 : a.receiver > b.receiver ? 1 : a.amountCents - b.amountCents));
  return {
    senderBatchId,
    body: {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: `Clause-to-Cash payout: ${req.contractId} ${req.period}`,
        email_message: "Sandbox payout calculated from your contract.",
      },
      items: lines.map((l) => ({
        recipient_type: "EMAIL",
        amount: { value: centsToValue(l.amountCents), currency: "USD" },
        receiver: l.receiver,
        note: req.note ?? `${req.contractId} ${req.period}: ${l.party}`,
        sender_item_id: senderItemId(senderBatchId, l.party),
      })),
    },
  };
}

export interface CreateResult {
  senderBatchId: string;
  requestId: string;
  payoutBatchId: string;
  batchStatus: string;
}

export async function createPayoutBatch(
  req: PayoutBatchRequest,
  opts: { client?: PayPalFetch; requestId?: string } = {},
): Promise<CreateResult> {
  const client = opts.client ?? (await defaultClient());
  const { senderBatchId, body } = buildPayoutBody(req);
  const requestId = opts.requestId ?? senderBatchId;
  const res: any = await client("/v1/payments/payouts", {
    method: "POST",
    headers: { "PayPal-Request-Id": requestId },
    body: JSON.stringify(body),
  });
  return {
    senderBatchId,
    requestId,
    payoutBatchId: res.batch_header?.payout_batch_id,
    batchStatus: res.batch_header?.batch_status,
  };
}

export interface BatchStatus {
  payoutBatchId: string;
  senderBatchId: string;
  batchStatus: string;
  items: Omit<PayoutItemRecord, "party">[];
}

export async function getBatch(payoutBatchId: string, opts: { client?: PayPalFetch } = {}): Promise<BatchStatus> {
  const client = opts.client ?? (await defaultClient());
  const res: any = await client(`/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
  return {
    payoutBatchId: res.batch_header?.payout_batch_id,
    senderBatchId: res.batch_header?.sender_batch_header?.sender_batch_id,
    batchStatus: res.batch_header?.batch_status,
    items: (res.items ?? []).map((i: any) => ({
      receiver: i.payout_item?.receiver,
      amountCents: valueToCents(i.payout_item?.amount?.value ?? "0"),
      senderItemId: i.payout_item?.sender_item_id,
      payoutItemId: i.payout_item_id,
      transactionId: i.transaction_id,
      transactionStatus: i.transaction_status,
      error: i.errors ? `${i.errors.name}: ${i.errors.message}` : undefined,
    })),
  };
}

const BATCH_FINAL = new Set(["SUCCESS", "DENIED", "CANCELED"]);
const ITEM_FINAL = new Set(["SUCCESS", "FAILED", "UNCLAIMED", "RETURNED", "ONHOLD", "BLOCKED", "REFUNDED", "REVERSED"]);

export function isFinal(s: BatchStatus): boolean {
  if (s.batchStatus === "DENIED" || s.batchStatus === "CANCELED") return true;
  return BATCH_FINAL.has(s.batchStatus) && s.items.every((i) => ITEM_FINAL.has(i.transactionStatus ?? ""));
}

/** Poll every intervalMs (default 3s) for up to timeoutMs (default 60s). */
export async function pollBatch(
  payoutBatchId: string,
  opts: { client?: PayPalFetch; intervalMs?: number; timeoutMs?: number; onTick?: (s: BatchStatus) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ status: BatchStatus; final: boolean }> {
  const interval = opts.intervalMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let status = await getBatch(payoutBatchId, opts);
  opts.onTick?.(status);
  while (!isFinal(status) && Date.now() < deadline) {
    await sleep(interval);
    status = await getBatch(payoutBatchId, opts);
    opts.onTick?.(status);
  }
  return { status, final: isFinal(status) };
}

/** Pull PayPal's error fields out of a thrown PayPalError (duck-typed). */
export function paypalErrorInfo(e: unknown) {
  const err = e as { status?: number; errorName?: string; message?: string; debugId?: string; body?: any };
  const d = err.body?.details?.[0];
  return {
    status: err.status,
    name: err.errorName ?? err.body?.name,
    message: err.body?.message ?? err.message,
    debugId: err.debugId,
    issue: d ? [d.field, d.issue, d.description].filter(Boolean).join(": ") : undefined,
  };
}
