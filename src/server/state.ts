// Server-side state for the UI: contracts, reviewed rules, plans, approvals, payouts.
// Everything that changes is an append to the ledger.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExtraction, isDemoMode } from "../ai/cache";
import { contractIdFromText, textHash, type Extraction } from "../ai/extract";
import { approveLine, planPayrun, reconcile, recordPlan, refreshBatch, submitPayrun, type Plan, type ReconRow } from "../core/payrun";
import { accounts } from "../engine/accounts";
import { sum } from "../engine/money";
import { findQuoteRange } from "../engine/quotes";
import { SAMPLE_IDS, loadContractText, type SampleId } from "../engine/samples";
import type { ContractRules, Rule } from "../engine/schema";
import { naiveEqualSplit } from "../engine/simulate";
import { Ledger, type LedgerEntry, type RevenueEntry } from "../ledger/ledger";

const root = () => process.env.C2C_ROOT ?? process.cwd();
const dataDir = () => process.env.DATA_DIR ?? join(root(), "data");
const uploadsDir = () => join(dataDir(), "uploads");
export const DEMO_FIXTURE_LEDGER = "fixtures/ledger.sandbox-2026-11-09.jsonl";

/** DEMO_MODE uses its own ledger, seeded once from the recorded sandbox run. */
export function getLedger(): Ledger {
  if (!isDemoMode()) return Ledger.default();
  const p = join(dataDir(), "demo", "ledger.jsonl");
  if (!existsSync(p)) {
    mkdirSync(join(dataDir(), "demo"), { recursive: true });
    copyFileSync(join(root(), DEMO_FIXTURE_LEDGER), p);
  }
  return new Ledger(p);
}

export interface ContractSummary {
  key: string;
  contractId: string;
  title: string;
  source: "sample" | "upload";
}

export function listContracts(): ContractSummary[] {
  const out: ContractSummary[] = SAMPLE_IDS.map((id) => {
    const text = loadContractText(id);
    return { key: id, contractId: contractIdFromText(text) ?? id, title: text.split("\n").find((l) => l.trim() && !l.startsWith("==="))!.trim(), source: "sample" as const };
  });
  if (existsSync(uploadsDir())) {
    for (const f of readdirSync(uploadsDir()).filter((f) => f.endsWith(".txt")).sort()) {
      const key = f.slice(0, -4);
      const text = readFileSync(join(uploadsDir(), f), "utf8");
      out.push({ key, contractId: contractIdFromText(text) ?? key, title: text.split("\n").find((l) => l.trim() && !l.startsWith("==="))?.trim().slice(0, 80) ?? key, source: "upload" });
    }
  }
  return out;
}

function contractText(key: string): string {
  if ((SAMPLE_IDS as readonly string[]).includes(key)) return loadContractText(key as SampleId);
  if (!/^upload-[0-9a-f]{16}$/.test(key)) throw new Error(`Unknown contract "${key}"`);
  return readFileSync(join(uploadsDir(), `${key}.txt`), "utf8");
}

/** Save an uploaded contract and extract it; the file is removed again if extraction fails. */
export async function addUpload(text: string): Promise<string> {
  const key = await saveUpload(text);
  const p = join(uploadsDir(), `${key}.txt`);
  try {
    await loadContract(key);
    return key;
  } catch (e) {
    if (!SAMPLE_IDS.includes(key as SampleId)) rmSync(p, { force: true });
    throw e;
  }
}

export async function saveUpload(text: string): Promise<string> {
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.trim().length < 50) throw new Error("Contract text is too short.");
  if (clean.length > 60_000) throw new Error("Contract text is too long for this demo (60k characters max).");
  const key = `upload-${textHash(clean)}`;
  mkdirSync(uploadsDir(), { recursive: true });
  writeFileSync(join(uploadsDir(), `${key}.txt`), clean);
  return key;
}

/** Apply the latest confirm/reject per rule from the ledger. */
function applyReviews(c: ContractRules, entries: readonly LedgerEntry[]): ContractRules {
  const latest = new Map<string, Rule["status"]>();
  for (const e of entries) if (e.type === "rule_review" && e.contractId === c.contractId) latest.set(e.ruleId, e.status);
  return { ...c, rules: c.rules.map((r) => (latest.has(r.id) ? { ...r, status: latest.get(r.id)! } : r)) };
}

export function acceptedMilestones(entries: readonly LedgerEntry[], contractId: string, period: string): string[] {
  const state = new Map<string, boolean>();
  for (const e of entries) if (e.type === "milestone_accepted" && e.contractId === contractId && e.period === period) state.set(e.milestone, e.accepted);
  return [...state].filter(([, v]) => v).map(([k]) => k);
}

export interface LoadedContract {
  key: string;
  text: string;
  extraction: Omit<Extraction, "contract">;
  fromCache: boolean;
  contract: ContractRules; // with reviews applied
  ranges: Record<string, [number, number] | null>;
  unmodeled: NonNullable<Extraction["unmodeled"]>;
}

export async function loadContract(key: string, opts: { force?: boolean } = {}): Promise<LoadedContract> {
  const text = contractText(key);
  const { extraction, fromCache } = await getExtraction(text, key, opts);
  const contract = applyReviews(extraction.contract, getLedger().read());
  const unmodeled = extraction.unmodeled ?? [];
  const ranges = Object.fromEntries([
    ...contract.rules.map((r) => [r.id, findQuoteRange(text, r.source.quote)] as const),
    ...unmodeled.map((u) => [u.id, findQuoteRange(text, u.quote)] as const),
  ]);
  const { contract: _c, ...meta } = extraction;
  return { key, text, extraction: meta, fromCache, contract, ranges, unmodeled };
}

export function reviewRule(contractId: string, ruleId: string, status: Rule["status"], by = "ui") {
  return getLedger().append({ type: "rule_review", contractId, ruleId, status, by });
}

export function setMilestone(contractId: string, period: string, milestone: string, accepted: boolean, by = "ui") {
  return getLedger().append({ type: "milestone_accepted", contractId, period, milestone, accepted, by });
}

export interface PlanInput {
  key: string;
  period: string;
  captureIds?: string[]; // subset of captured orders (simulator); default all for the period
  whatIfCents?: number; // simulated revenue (simulator only; never payable)
}

export interface PlanView {
  demoMode: boolean;
  contract: ContractRules;
  period: string;
  periods: string[];
  revenueSource: "captured" | "simulated";
  captures: (RevenueEntry & { selected: boolean; fixture: boolean })[];
  milestones: { name: string; accepted: boolean }[];
  plan: Plan;
  naive: Record<string, number>;
  recon: ReconRow[];
  partyNames: Record<string, string>;
  payableTotalCents: number;
  fixtureLedger: boolean;
  submittedBatches: { senderBatchId: string; payoutBatchId: string; ts: string }[];
}

export async function buildPlan(input: PlanInput): Promise<PlanView> {
  const { contract, unmodeled } = await loadContract(input.key);
  const ledger = getLedger();
  const entries = ledger.read();
  const revenue = entries.filter((e): e is LedgerEntry & RevenueEntry => e.type === "revenue" && e.contractId === contract.contractId);
  const periods = [...new Set([input.period, ...revenue.map((r) => r.period)])].sort().reverse();
  const forPeriod = revenue.filter((r) => r.period === input.period);
  const selected = new Set(input.captureIds ?? forPeriod.map((r) => r.captureId));
  const simulated = input.whatIfCents !== undefined;
  const capturedCents = sum(forPeriod.filter((r) => selected.has(r.captureId)).map((r) => r.amountCents));
  const revenueCents = simulated ? input.whatIfCents! : capturedCents;
  const done = acceptedMilestones(entries, contract.contractId, input.period);
  const plan = planPayrun({ contract, period: input.period, revenueCents, completedMilestones: done, entries, openClauses: unmodeled });
  if (simulated) {
    // What-if revenue is never payable.
    for (const r of plan.rows) r.payable = false;
    plan.payableLines = [];
    plan.senderBatchId = null;
  }
  const payees = contract.parties.map((p) => p.id);
  const fixtureSeqs = new Set(isDemoMode() ? readFileSync(join(root(), DEMO_FIXTURE_LEDGER), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).hash as string) : []);
  return {
    demoMode: isDemoMode(),
    contract,
    period: input.period,
    periods,
    revenueSource: simulated ? "simulated" : "captured",
    captures: forPeriod.map((r) => ({ ...r, selected: selected.has(r.captureId), fixture: fixtureSeqs.has((r as LedgerEntry).hash) })),
    milestones: contract.rules.flatMap((r) => (r.type === "milestone_payment" ? [{ name: r.params.milestone, accepted: done.includes(r.params.milestone) }] : [])),
    plan,
    // Same total the contract pays out now, divided equally: shows misallocation, not a different payout size.
    naive: Object.fromEntries(naiveEqualSplit(sum(plan.rows.map((r) => r.line.amountCents)), payees)),
    recon: reconcile(plan, entries),
    partyNames: Object.fromEntries(contract.parties.map((p) => [p.id, p.name])),
    payableTotalCents: sum(plan.payableLines.map((l) => l.amountCents)),
    fixtureLedger: isDemoMode(),
    submittedBatches: entries.flatMap((e) => (e.type === "payout_submitted" && e.contractId === contract.contractId && e.period === input.period ? [{ senderBatchId: e.senderBatchId, payoutBatchId: e.payoutBatchId, ts: e.ts }] : [])),
  };
}

export async function approve(key: string, period: string, party: string, by: string, note?: string) {
  const view = await buildPlan({ key, period });
  return approveLine(getLedger(), view.plan, party, by, note);
}

export async function sendPayout(key: string, period: string, confirmTotalCents: number) {
  if (isDemoMode()) throw new Error("DEMO_MODE: sending payouts is disabled. The ledger shows a recorded sandbox run instead.");
  const view = await buildPlan({ key, period });
  if (view.payableTotalCents !== confirmTotalCents) {
    throw new Error(`The payable total changed (now ${view.payableTotalCents} cents, you confirmed ${confirmTotalCents}). Reload and check again.`);
  }
  const ledger = getLedger();
  recordPlan(ledger, view.plan, view.contract);
  return submitPayrun(ledger, view.plan, {});
}

export async function refresh(key: string, period: string, payoutBatchId: string) {
  if (isDemoMode()) throw new Error("DEMO_MODE: PayPal calls are disabled.");
  const view = await buildPlan({ key, period });
  return refreshBatch(getLedger(), view.plan, payoutBatchId);
}

export function ledgerView(contractId?: string) {
  const l = getLedger();
  const entries = l.read().filter((e) => !contractId || ("contractId" in e && e.contractId === contractId));
  return { path: l.path.replace(root() + "/", ""), brokenAt: l.verify(), entries: entries.reverse(), demoMode: isDemoMode() };
}

export const sandboxAccounts = () => accounts.map((a) => ({ role: a.role, email: a.email }));
