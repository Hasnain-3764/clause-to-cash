// Runs every step in order and prints a PASS/FAIL checklist.
// NOTE: step 2 needs you in a browser, and step 3 sends (fake) sandbox money.
import { runToken } from "./01-token.ts";
import { runOrder } from "./02-order.ts";
import { runPayout } from "./03-payout.ts";
import { runChannel3 } from "./04-channel3.ts";

const steps: Array<[string, () => Promise<boolean | "skipped">]> = [
  ["PayPal token OK", runToken],
  ["Order created and captured", runOrder],
  ["Payout to freelancer-a reached SUCCESS", runPayout],
  ["Channel3 search returned products", runChannel3],
];

const results: Array<[string, boolean | "skipped"]> = [];
for (const [label, fn] of steps) {
  console.log(`\n=== ${label} ===`);
  let ok: boolean | "skipped" = false;
  try { ok = await fn(); } catch (e: any) { if (!e?.debugId) console.error(String(e?.message ?? e)); }
  results.push([label, ok]);
}

console.log("\n=== Checklist ===");
for (const [label, ok] of results) console.log(`  [${ok === "skipped" ? "SKIP" : ok ? "PASS" : "FAIL"}] ${label}`);
// SKIP is not a failure, but it is not a pass either: exit 0 only if nothing FAILed.
process.exit(results.some(([, ok]) => ok === false) ? 1 : 0);
