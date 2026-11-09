// Create and capture sandbox orders, saving each capture as a revenue record in the ledger.
//
//   npm run revenue -- create --contract creator-collab --period 2026-11 --amount 500.00
//       -> prints an approve link; a human approves it in the browser as a sandbox buyer
//   npm run revenue -- capture
//       -> captures every approved pending order and appends a "revenue" ledger entry
//   npm run revenue -- list
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { centsToValue, formatUSD, valueToCents } from "../src/engine/money";
import { SAMPLE_IDS, loadExpectedRules, type SampleId } from "../src/engine/samples";
import { Ledger } from "../src/ledger/ledger";
import { paypalFetch, PayPalError } from "./lib/paypal.ts";

interface Pending {
  orderId: string;
  contractId: string;
  period: string;
  amountCents: number;
  approveUrl: string;
  createdAt: string;
}

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const pendingPath = join(dataDir, "pending-orders.json");
const readPending = (): Pending[] => (existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, "utf8")) : []);
const writePending = (p: Pending[]) => {
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify(p, null, 2) + "\n");
};

async function create(contract: SampleId, period: string, amount: string) {
  const contractId = loadExpectedRules(contract).contractId;
  const amountCents = valueToCents(amount);
  if (amountCents <= 0) throw new Error("amount must be > 0");
  const order: any = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": `c2c-order-${randomUUID()}` },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: contractId,
        custom_id: `${contractId}|${period}`,
        description: `Sandbox revenue for ${contractId} (${period})`,
        amount: { currency_code: "USD", value: centsToValue(amountCents) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: "http://localhost:3000/return",
            cancel_url: "http://localhost:3000/cancel",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    }),
  });
  const approve = (order.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
  if (!approve) throw new Error("No approve link in PayPal's response");
  writePending([...readPending(), { orderId: order.id, contractId, period, amountCents, approveUrl: approve.href, createdAt: new Date().toISOString() }]);
  console.log(`Order ${order.id} for ${formatUSD(amountCents)} (${contractId}, ${period}) status=${order.status}`);
  console.log(`Approve as a sandbox BUYER (buyer-1) in a private window:\n  ${approve.href}`);
  console.log(`Then run: npm run revenue -- capture`);
}

async function capture() {
  const ledger = Ledger.default();
  const pending = readPending();
  if (!pending.length) return console.log("No pending orders.");
  const left: Pending[] = [];
  for (const p of pending) {
    try {
      const cap: any = await paypalFetch(`/v2/checkout/orders/${p.orderId}/capture`, {
        method: "POST",
        headers: { "PayPal-Request-Id": `c2c-capture-${p.orderId}` },
      });
      const c = cap.purchase_units?.[0]?.payments?.captures?.[0];
      if (cap.status !== "COMPLETED" || c?.status !== "COMPLETED") {
        console.log(`Order ${p.orderId}: order=${cap.status} capture=${c?.status} (${c?.status_details?.reason ?? ""}); not recorded`);
        left.push(p);
        continue;
      }
      const amountCents = valueToCents(c.amount.value);
      ledger.append({
        type: "revenue", contractId: p.contractId, period: p.period, orderId: p.orderId, captureId: c.id,
        amountCents, payerEmail: cap.payer?.email_address ?? null, capturedAt: c.create_time ?? new Date().toISOString(),
      });
      console.log(`Captured ${p.orderId}: capture_id=${c.id} ${formatUSD(amountCents)} from ${cap.payer?.email_address ?? "?"} -> revenue for ${p.contractId} ${p.period}`);
    } catch (e) {
      const issue = e instanceof PayPalError ? e.body?.details?.[0]?.issue : undefined;
      if (issue === "ORDER_NOT_APPROVED") console.log(`Order ${p.orderId}: not approved yet. Link: ${p.approveUrl}`);
      else if (issue === "ORDER_ALREADY_CAPTURED") console.log(`Order ${p.orderId}: already captured (dropping from pending).`);
      else console.log(`Order ${p.orderId}: capture failed (${e instanceof Error ? e.message : String(e)})`);
      if (issue !== "ORDER_ALREADY_CAPTURED") left.push(p);
    }
  }
  writePending(left);
}

function list() {
  const rev = Ledger.default().read().filter((e) => e.type === "revenue");
  if (!rev.length) console.log("No captured revenue yet.");
  for (const e of rev) if (e.type === "revenue") console.log(`${e.contractId} ${e.period} ${formatUSD(e.amountCents).padStart(10)} order=${e.orderId} capture=${e.captureId}`);
  for (const p of readPending()) console.log(`PENDING ${p.contractId} ${p.period} ${formatUSD(p.amountCents)} order=${p.orderId} ${p.approveUrl}`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { contract: { type: "string", default: "creator-collab" }, period: { type: "string", default: new Date().toISOString().slice(0, 7) }, amount: { type: "string" } },
});
const cmd = positionals[0] ?? "list";
try {
  if (cmd === "create") {
    if (!SAMPLE_IDS.includes(values.contract as SampleId)) throw new Error(`--contract must be one of ${SAMPLE_IDS.join(", ")}`);
    if (!values.amount) throw new Error("--amount is required, e.g. --amount 500.00");
    await create(values.contract as SampleId, values.period!, values.amount);
  } else if (cmd === "capture") await capture();
  else list();
} catch (e) {
  if (!(e instanceof PayPalError)) console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
