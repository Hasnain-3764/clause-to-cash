import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveLine, planPayrun, reconcile, revenueFor, submitPayrun } from "../src/core/payrun";
import { loadExpectedRules } from "../src/engine/samples";
import { Ledger } from "../src/ledger/ledger";
import { buildPayoutBody, pollBatch, type PayPalFetch } from "../src/paypal/payouts";

/**
 * In-memory stand-in for the PayPal Payouts API. Observed in sandbox on 2026-11-09:
 * reusing a sender_batch_id is rejected with 400 USER_BUSINESS_ERROR even when the
 * PayPal-Request-Id is the same (no replay). `replayOnSameRequestId` models the
 * replay behaviour other PayPal APIs have, so both code paths stay tested.
 */
function fakePayPal(opts: { settleAfter?: number; replayOnSameRequestId?: boolean } = {}) {
  const batches = new Map<string, { id: string; body: any; gets: number }>();
  const byRequestId = new Map<string, any>();
  let n = 0;
  const calls: string[] = [];
  const client: PayPalFetch = async (path: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (init.method === "POST") {
      const rid = new Headers(init.headers).get("PayPal-Request-Id")!;
      if (opts.replayOnSameRequestId && byRequestId.has(rid)) return byRequestId.get(rid);
      const body = JSON.parse(String(init.body));
      const sbid = body.sender_batch_header.sender_batch_id;
      if ([...batches.values()].some((b) => b.body.sender_batch_header.sender_batch_id === sbid)) {
        throw Object.assign(new Error("400 USER_BUSINESS_ERROR"), { status: 400, errorName: "USER_BUSINESS_ERROR", body: { name: "USER_BUSINESS_ERROR", details: [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }] } });
      }
      const id = `PB${++n}`;
      batches.set(id, { id, body, gets: 0 });
      const res = { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } };
      byRequestId.set(rid, res);
      return res;
    }
    const id = path.split("/").pop()!;
    const b = batches.get(id)!;
    b.gets++;
    const done = b.gets > (opts.settleAfter ?? 1);
    return {
      batch_header: { payout_batch_id: id, batch_status: done ? "SUCCESS" : "PROCESSING", sender_batch_header: b.body.sender_batch_header },
      items: b.body.items.map((it: any, i: number) => ({
        payout_item_id: `${id}-I${i}`,
        transaction_id: done ? `TX${id}${i}` : undefined,
        transaction_status: done ? "SUCCESS" : "PENDING",
        payout_item: { receiver: it.receiver, amount: it.amount, sender_item_id: it.sender_item_id },
      })),
    };
  };
  return { client, calls, batches };
}

const tmpLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "c2c-")), "ledger.jsonl"));
const fast = { pollIntervalMs: 1, pollTimeoutMs: 1000 };

function seedRevenue(ledger: Ledger, contractId: string, period: string, ...amounts: number[]) {
  amounts.forEach((a, i) => ledger.append({ type: "revenue", contractId, period, orderId: `O${i}`, captureId: `C${i}`, amountCents: a, payerEmail: "buyer@personal.example.com", capturedAt: "2026-11-09T00:00:00Z" }));
}

describe("ledger", () => {
  it("is append-only and hash-chained; tampering is detected", () => {
    const l = tmpLedger();
    seedRevenue(l, "c", "2026-11", 500, 300);
    seedRevenue(l, "c", "2026-11", 500); // same capture id C0 again: deduped
    expect(l.verify()).toBeNull();
    expect(revenueFor(l.read(), "c", "2026-11").cents).toBe(800);
    const text = readFileSync(l.path, "utf8").replace('"amountCents":300', '"amountCents":30000');
    writeFileSync(l.path, text);
    expect(l.verify()).toBe(2);
  });
});

describe("payouts adapter", () => {
  it("builds a deterministic body with sorted lines and a stable sender_batch_id", () => {
    const lines = [{ party: "b", receiver: "b@x.example.com", amountCents: 4000 }, { party: "a", receiver: "a@x.example.com", amountCents: 14400 }];
    const one = buildPayoutBody({ contractId: "c", period: "p", lines });
    const two = buildPayoutBody({ contractId: "c", period: "p", lines: [...lines].reverse() });
    expect(one).toEqual(two);
    expect(one.body.items.map((i) => i.amount.value)).toEqual(["144.00", "40.00"]);
    expect(one.body.sender_batch_header.sender_batch_id).toBe(one.senderBatchId);
    for (const i of one.body.items) expect(i.sender_item_id.length).toBeLessThanOrEqual(63);
  });

  it("polls until the batch and all items are final", async () => {
    const pp = fakePayPal({ settleAfter: 3 });
    await pp.client("/v1/payments/payouts", { method: "POST", headers: { "PayPal-Request-Id": "r" }, body: JSON.stringify(buildPayoutBody({ contractId: "c", period: "p", lines: [{ party: "a", receiver: "a@x.example.com", amountCents: 1 }] }).body) });
    const ticks: string[] = [];
    const { status, final } = await pollBatch("PB1", { client: pp.client, intervalMs: 1, onTick: (s) => ticks.push(s.batchStatus) });
    expect(final).toBe(true);
    expect(status.items[0].transactionStatus).toBe("SUCCESS");
    expect(ticks).toEqual(["PROCESSING", "PROCESSING", "PROCESSING", "SUCCESS"]);
  });
});

describe("payrun end to end (fake PayPal)", () => {
  const contract = loadExpectedRules("creator-collab");
  const period = "2026-11";

  it("pays allowed lines, reconciles to the cent, and blocks a duplicate three ways", async () => {
    const ledger = tmpLedger();
    seedRevenue(ledger, contract.contractId, period, 50_000, 30_000); // $800
    const pp = fakePayPal();
    const plan = planPayrun({ contract, period, revenueCents: revenueFor(ledger.read(), contract.contractId, period).cents, entries: ledger.read() });
    expect(plan.payableLines.map((l) => [l.party, l.amountCents])).toEqual([["creator", 14_400], ["editor", 4_000]]);

    const out = await submitPayrun(ledger, plan, { client: pp.client, ...fast });
    expect(out.kind).toBe("submitted");
    const recon = reconcile(plan, ledger.read());
    expect(recon.map((r) => [r.party, r.status, r.diffCents])).toEqual([["creator", "matched", 0], ["editor", "matched", 0]]);
    expect(recon[0].transactionIds).toEqual(["TXPB10"]);

    // 1. Our own ledger guard.
    expect(await submitPayrun(ledger, plan, { client: pp.client, ...fast })).toMatchObject({ kind: "duplicate", outcome: "blocked_locally" });
    // 2. Same PayPal-Request-Id: real sandbox rejects the reused sender_batch_id.
    expect(await submitPayrun(ledger, plan, { client: pp.client, skipLocalGuard: true, ...fast })).toMatchObject({ kind: "duplicate", outcome: "rejected" });
    // 3. New request id, same sender_batch_id: PayPal rejects it.
    expect(await submitPayrun(ledger, plan, { client: pp.client, skipLocalGuard: true, requestId: "other", ...fast })).toMatchObject({ kind: "duplicate", outcome: "rejected" });
    expect(pp.batches.size).toBe(1);
    expect(reconcile(plan, ledger.read()).every((r) => r.status === "matched")).toBe(true);
    expect(ledger.verify()).toBeNull();
  });

  it("if PayPal replays the original response for the same request id, no new batch is recorded", async () => {
    const ledger = tmpLedger();
    const pp = fakePayPal({ replayOnSameRequestId: true });
    const plan = planPayrun({ contract, period, revenueCents: 80_000, entries: [] });
    await submitPayrun(ledger, plan, { client: pp.client, ...fast });
    expect(await submitPayrun(ledger, plan, { client: pp.client, skipLocalGuard: true, ...fast })).toMatchObject({ kind: "duplicate", outcome: "replayed" });
    expect(ledger.read().filter((e) => e.type === "payout_submitted")).toHaveLength(1);
  });

  it("needs_approval lines are held until approved, and the approval is tied to the exact amount", async () => {
    const ledger = tmpLedger();
    seedRevenue(ledger, contract.contractId, period, 800_000); // $8,000 -> creator $1,710 over threshold
    let plan = planPayrun({ contract, period, revenueCents: 800_000, entries: ledger.read() });
    expect(plan.rows.find((r) => r.line.party === "creator")!.payable).toBe(false);
    expect(reconcile(plan, ledger.read()).find((r) => r.party === "creator")!.status).toBe("awaiting_approval");
    approveLine(ledger, plan, "creator", "tester");
    plan = planPayrun({ contract, period, revenueCents: 800_000, entries: ledger.read() });
    expect(plan.rows.find((r) => r.line.party === "creator")!.payable).toBe(true);
    // Revenue changes -> amount changes -> old approval no longer applies.
    const other = planPayrun({ contract, period, revenueCents: 900_000, entries: ledger.read() });
    expect(other.rows.find((r) => r.line.party === "creator")!.payable).toBe(false);
    expect(() => approveLine(ledger, plan, "editor", "tester")).toThrow(/only needs_approval/);
  });

  it("denied lines are never sent and show as blocked", async () => {
    const music = loadExpectedRules("music-split");
    const ledger = tmpLedger();
    const pp = fakePayPal();
    const plan = planPayrun({ contract: music, period, revenueCents: 100_000, entries: [] });
    await submitPayrun(ledger, plan, { client: pp.client, ...fast });
    const sent = [...pp.batches.values()][0].body.items.map((i: any) => i.receiver);
    expect(sent).not.toContain("sb-gtrpk00000000@personal.example.com");
    expect(reconcile(plan, ledger.read()).find((r) => r.party === "guitarist")!.status).toBe("blocked");
  });
});
