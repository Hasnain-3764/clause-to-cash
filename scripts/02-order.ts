// Step 2: create a 10.00 USD order, have the buyer approve it in a browser, then capture it.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { isMain, paypalFetch, PayPalError } from "./lib/paypal.ts";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

export async function runOrder(): Promise<boolean | "skipped"> {
  const order = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": `order-${randomUUID()}` }, // idempotency key
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "smoke-1", amount: { currency_code: "USD", value: "10.00" } }],
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
  console.log(`Order created: id=${order.id}, status=${order.status}`);
  if (!approve) {
    console.error("No approve/payer-action link in the response.");
    return false;
  }
  console.log(`\nApprove link:\n  ${approve.href}\n`);
  console.log("1. Open that link in a PRIVATE / INCOGNITO window.");
  console.log("2. Log in as buyer-1 (sb-qfcbx53715178@personal.example.com); the password is in .passwords.");
  console.log("3. Approve the payment. You'll land on localhost:3000/return, which won't load. That's fine.\n");

  // Let the user retry if they press Enter before approving.
  for (;;) {
    const answer = await ask("Press Enter after approving (or type q to give up): ");
    if (answer.trim().toLowerCase() === "q") {
      console.log(`Skipped. Order ${order.id} was left unapproved (it simply expires).`);
      return "skipped";
    }
    try {
      const cap = await paypalFetch(`/v2/checkout/orders/${order.id}/capture`, {
        method: "POST",
        headers: { "PayPal-Request-Id": `capture-${order.id}` },
      });
      const capture = cap.purchase_units?.[0]?.payments?.captures?.[0];
      console.log(`\nFinal order status: ${cap.status}`);
      console.log(`Capture id:         ${capture?.id ?? "(missing)"}  status=${capture?.status ?? "?"}`);
      console.log(`Payer:              ${cap.payer?.email_address ?? "?"}`);
      if (capture?.status === "PENDING") {
        console.log(`Pending reason:     ${capture.status_details?.reason ?? "?"}`);
      }
      return cap.status === "COMPLETED" && capture?.status === "COMPLETED";
    } catch (e) {
      if (e instanceof PayPalError && e.body?.details?.[0]?.issue === "ORDER_NOT_APPROVED") {
        console.log("Not approved yet. Finish approving in the browser, then press Enter again.");
        continue;
      }
      throw e;
    }
  }
}

if (isMain(import.meta.url)) {
  runOrder().then((ok) => process.exit(ok === true ? 0 : 1), () => process.exit(1));
}
