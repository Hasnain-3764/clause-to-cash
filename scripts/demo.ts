// End-to-end CLI: contract rules -> captured revenue -> simulate -> policy -> approvals
// -> PayPal sandbox payout -> poll -> ledger -> reconciliation.
//
//   npm run demo                                        dry run for creator-collab, this month
//   npm run demo -- --contract agency-freelancer --milestone "Milestone 1 (Brand Kit)"
//   npm run demo -- --approve creator                   record an approval for a needs_approval line
//   npm run demo -- --send                              actually send the sandbox payout
//   npm run demo -- --send --resubmit                   skip our ledger guard to see PayPal's own duplicate answer
//   npm run demo -- --send --resubmit --new-request-id  same sender_batch_id, different PayPal-Request-Id
//   npm run demo -- --refresh <payout_batch_id>         re-fetch a batch that was still pending
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { approveLine, planPayrun, reconcile, recordPlan, refreshBatch, revenueFor, submitPayrun, type Plan } from "../src/core/payrun";
import { formatUSD, valueToCents } from "../src/engine/money";
import { SAMPLE_IDS, loadExpectedRules, type SampleId } from "../src/engine/samples";
import { Ledger } from "../src/ledger/ledger";

const { values } = parseArgs({
  options: {
    contract: { type: "string", default: "creator-collab" },
    period: { type: "string", default: new Date().toISOString().slice(0, 7) },
    revenue: { type: "string" },
    milestone: { type: "string", multiple: true, default: [] },
    approve: { type: "string", multiple: true, default: [] },
    send: { type: "boolean", default: false },
    resubmit: { type: "boolean", default: false },
    "new-request-id": { type: "boolean", default: false },
    refresh: { type: "string" },
  },
});

const id = values.contract as SampleId;
if (!SAMPLE_IDS.includes(id)) {
  console.error(`--contract must be one of ${SAMPLE_IDS.join(", ")}`);
  process.exit(1);
}
const contract = loadExpectedRules(id);
const period = values.period!;
const ledger = Ledger.default();

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const money = (c: number) => formatUSD(c).padStart(11);

function printPlan(plan: Plan, simulated: boolean) {
  const s = plan.simulation;
  console.log(`\n${contract.title} (${contract.contractId}), period ${period}`);
  console.log(`Revenue ${formatUSD(plan.revenueCents)}${simulated ? "  [SIMULATED: --revenue given, not captured]" : "  [captured sandbox orders]"}`);
  console.log(`\n  ${pad("party", 12)}${pad("receiver", 40)}${"amount".padStart(11)}  ${pad("decision", 15)}reasons`);
  for (const r of plan.rows) {
    const reasons = r.policy.reasons.map((x) => x.code).join(", ") + (r.approved ? "  (APPROVED)" : "");
    console.log(`  ${pad(r.line.party, 12)}${pad(r.line.receiver ?? "(none)", 40)}${money(r.line.amountCents)}  ${pad(r.policy.decision, 15)}${reasons}`);
  }
  console.log(`\n  reserve held ${formatUSD(s.reserveCents)} | recouped ${formatUSD(s.recoupedCents)} | kept by ${contract.payer} ${formatUSD(s.retainedCents - s.recoupedCents)}`);
  for (const w of s.warnings) console.log(`  ${w.severity === "conflict" ? "CONFLICT" : w.severity.toUpperCase()}: ${w.code} ${w.message}`);
  const total = plan.payableLines.reduce((a, l) => a + l.amountCents, 0);
  console.log(`\nPayable now: ${plan.payableLines.length} line(s), ${formatUSD(total)}  sender_batch_id=${plan.senderBatchId ?? "(none)"}`);
}

function printRecon(plan: Plan) {
  console.log(`\nReconciliation (contract-expected vs PayPal-paid)`);
  for (const r of reconcile(plan, ledger.read())) {
    const tick = r.status === "matched" ? "OK " : "-- ";
    console.log(`  ${tick}${pad(r.party, 12)}expected ${money(r.expectedCents)}  paid ${money(r.paidCents)}  diff ${money(r.diffCents)}  ${pad(r.status, 18)}${r.transactionIds.join(",")}`);
  }
}

const captured = revenueFor(ledger.read(), contract.contractId, period);
const simulated = values.revenue !== undefined;
const revenueCents = simulated ? valueToCents(values.revenue!) : captured.cents;
if (!simulated && captured.cents === 0) {
  console.log(`No captured revenue for ${contract.contractId} ${period}. Capture some with:`);
  console.log(`  npm run revenue -- create --contract ${id} --period ${period} --amount 500.00`);
  console.log(`or preview with --revenue 800.00 (simulated; cannot be sent).`);
  process.exit(0);
}

let plan = planPayrun({ contract, period, revenueCents, completedMilestones: values.milestone, entries: ledger.read() });
for (const party of values.approve!) {
  approveLine(ledger, plan, party, process.env.USER ?? "cli");
  console.log(`Recorded approval for ${party}.`);
}
if (values.approve!.length) plan = planPayrun({ contract, period, revenueCents, completedMilestones: values.milestone, entries: ledger.read() });
printPlan(plan, simulated);

if (values.refresh) {
  const e = await refreshBatch(ledger, plan, values.refresh);
  console.log(`Refreshed ${values.refresh}: ${e.type === "payout_status" ? e.batchStatus : ""}`);
  printRecon(plan);
} else if (!values.send) {
  console.log(`\nDRY RUN: nothing sent. Add --send to pay these lines from the sandbox business account.`);
  printRecon(plan);
} else {
  if (simulated) {
    console.error("Refusing to send: revenue is simulated (--revenue). Capture real sandbox orders first.");
    process.exit(1);
  }
  recordPlan(ledger, plan, contract);
  const requestId = values["new-request-id"] ? `c2c-retry-${randomUUID()}` : undefined;
  console.log(`\nSending sandbox payout: sender_batch_id=${plan.senderBatchId} PayPal-Request-Id=${requestId ?? plan.senderBatchId}`);
  const out = await submitPayrun(ledger, plan, { skipLocalGuard: values.resubmit, requestId, log: console.log });
  if (out.kind === "duplicate") console.log(`\nDUPLICATE (${out.outcome}): ${JSON.stringify(out.detail)}`);
  else if (out.kind === "nothing_to_pay") console.log("Nothing payable.");
  else {
    console.log(`\nBatch ${out.payoutBatchId}: ${out.final.batchStatus}${out.settled ? "" : " (not settled after 60s; use --refresh)"}`);
    for (const i of out.final.items) console.log(`  ${pad(i.receiver, 40)}${money(i.amountCents)}  ${i.transactionStatus}  item=${i.payoutItemId} txn=${i.transactionId ?? "-"}${i.error ? "  " + i.error : ""}`);
  }
  printRecon(plan);
}
const broken = ledger.verify();
console.log(`\nLedger ${ledger.path}: ${ledger.read().length} entries, hash chain ${broken === null ? "intact" : `BROKEN at seq ${broken}`}`);
