// Stable batch key: same contract + period + set of lines => same sender_batch_id,
// no matter what order the lines come in. PayPal rejects a reused sender_batch_id,
// which is what stops a double payout.
import { createHash } from "node:crypto";

export interface KeyLine {
  receiver: string;
  amountCents: number;
}

export function batchIdempotencyKey(contractId: string, period: string, lines: readonly KeyLine[]): string {
  const sorted = lines
    .map((l) => [l.receiver.trim().toLowerCase(), l.amountCents] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
  const payload = JSON.stringify(["c2c-v1", contractId, period, sorted]);
  return "c2c-" + createHash("sha256").update(payload).digest("hex").slice(0, 40);
}
