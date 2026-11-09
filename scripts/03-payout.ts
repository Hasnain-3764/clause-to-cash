// Step 3: send a 5.00 USD sandbox payout from the business account to freelancer-a, then poll until it settles.
import { readFileSync } from "node:fs";
import { isMain, paypalFetch, PayPalError } from "./lib/paypal.ts";

const BATCH_FAIL = new Set(["DENIED", "CANCELED"]);
const ITEM_DONE = new Set(["SUCCESS", "FAILED", "UNCLAIMED", "RETURNED", "ONHOLD", "BLOCKED", "REFUNDED", "REVERSED"]);

/** Plain-English hints for the errors you're most likely to hit. */
function explain(name: string | undefined, status?: number): string | null {
  const n = (name ?? "").toUpperCase();
  if (n === "USER_COUNTRY_NOT_ALLOWED")
    return "The SENDER business account is not a US account. Create a US business sandbox account and an app under it.";
  if (n.includes("AUTHORIZ") || n.includes("PERMISSION") || status === 403)
    return "Payouts is probably not enabled for this app (Dashboard > Apps & Credentials > your app > Features > Payouts), or you just enabled it. Wait 10-15 minutes after saving.";
  if (n.includes("INSUFFICIENT_FUNDS"))
    return "The business sandbox balance is too low. Add funds to it in the Developer Dashboard (Sandbox accounts > business > ...).";
  if (n === "RECEIVER_UNREGISTERED")
    return "The receiver email has no PayPal sandbox account. Check FREELANCER_A_EMAIL.";
  if (n === "DUPLICATE_REQUEST_ID" || n === "SENDER_BATCH_ID_ALREADY_EXISTS" || n === "DUPLICATE_SENDER_BATCH_ID")
    return "That sender_batch_id was already used. Each run must use a new one.";
  return null;
}

function receiverEmail(): string {
  const email = process.env.FREELANCER_A_EMAIL;
  if (!email) throw new Error("FREELANCER_A_EMAIL missing from .env");
  // Safety: only pay an address listed in config/accounts.json as a sandbox account.
  const cfg = JSON.parse(readFileSync(new URL("../config/accounts.json", import.meta.url), "utf8"));
  const known = cfg.accounts.find((a: any) => a.email === email);
  if (!known || !email.endsWith(".example.com")) {
    throw new Error(`Refusing to pay ${email}: not a sandbox account in config/accounts.json`);
  }
  return email;
}

export async function runPayout(): Promise<boolean> {
  const receiver = receiverEmail();
  const stamp = Date.now();
  const senderBatchId = `smoke-${stamp}`; // new every run, so PayPal never sees a duplicate by accident
  const senderItemId = `smoke-item-${stamp}`;

  let created: any;
  try {
    created = await paypalFetch("/v1/payments/payouts", {
      method: "POST",
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject: "Sandbox smoke test payout",
          email_message: "Fake money from the hackathon smoke test.",
        },
        items: [{
          recipient_type: "EMAIL",
          amount: { value: "5.00", currency: "USD" },
          receiver,
          note: "Smoke test payout",
          sender_item_id: senderItemId,
        }],
      }),
    });
  } catch (e) {
    if (e instanceof PayPalError) {
      const hint = explain(e.errorName, e.status) ?? explain(e.body?.details?.[0]?.issue, e.status);
      if (hint) console.error(`  hint:     ${hint}`);
    }
    throw e;
  }

  const batchId = created.batch_header?.payout_batch_id;
  console.log(`Payout sent to ${receiver}: sender_batch_id=${senderBatchId}`);
  console.log(`payout_batch_id=${batchId}, batch_status=${created.batch_header?.batch_status}`);

  // Poll every 3s for up to 60s.
  const deadline = Date.now() + 60_000;
  let latest: any = created;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    latest = await paypalFetch(`/v1/payments/payouts/${batchId}`);
    const bs = latest.batch_header?.batch_status;
    const items: any[] = latest.items ?? [];
    console.log(`  ...batch_status=${bs}, items=[${items.map((i) => i.transaction_status).join(", ")}]`);
    if (BATCH_FAIL.has(bs)) break;
    if (bs === "SUCCESS" && items.every((i) => ITEM_DONE.has(i.transaction_status))) break;
  }

  const bs = latest.batch_header?.batch_status;
  console.log(`\nFinal batch_status: ${bs}`);
  let allOk = bs === "SUCCESS";
  for (const item of latest.items ?? []) {
    console.log(`  item ${item.payout_item?.sender_item_id ?? item.payout_item_id}: transaction_status=${item.transaction_status}` +
      (item.transaction_id ? `, transaction_id=${item.transaction_id}` : ""));
    if (item.transaction_status !== "SUCCESS") allOk = false;
    if (item.errors) {
      console.log(`    error: ${item.errors.name}: ${item.errors.message}`);
      const hint = explain(item.errors.name);
      if (hint) console.log(`    hint:  ${hint}`);
    }
  }
  if (!allOk && bs !== "SUCCESS" && !BATCH_FAIL.has(bs)) {
    console.log("Still not settled after 60s. Re-check later with GET /v1/payments/payouts/" + batchId);
  }
  return allOk;
}

if (isMain(import.meta.url)) {
  runPayout().then((ok) => process.exit(ok ? 0 : 1), () => process.exit(1));
}
