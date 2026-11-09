// AI extraction: contract text -> payment rules with cited clauses.
// The model fills a zod schema via generateObject. Every quote is then checked
// against the contract text; a quote that is not there gets confidence 0 and a flag,
// which makes policy() send that rule's payouts to the approval inbox.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Party, Rule, Source, type ContractRules } from "../engine/schema";
import { findQuotePage } from "../engine/quotes";

// ---------------------------------------------------------------------------
// Model-facing schema: same shapes as the engine, minus id/status (we assign
// those) and with descriptions that steer the model.

const llmBase = {
  party: z.string().describe("Party id from the parties list, e.g. 'creator'."),
  source: Source,
  confidence: z.number().min(0).max(1).describe("Your confidence that this rule is stated exactly as encoded (0-1)."),
};
const bps = z.number().int().min(0).max(10000).describe("Basis points: 1% = 100, 12.5% = 1250.");
const cents = z.number().int().min(0).describe("US cents: $1,500.00 = 150000.");

export const LlmRule = z.discriminatedUnion("type", [
  z.object({ ...llmBase, type: z.literal("percentage_split").describe("Party gets a fixed % of period revenue."), params: z.object({ basisPoints: bps }) }),
  z.object({
    ...llmBase,
    type: z.literal("tiered_split").describe("Party gets different % on bands of period revenue (marginal, like tax brackets)."),
    params: z.object({
      tiers: z.array(z.object({ upToCents: cents.nullable().describe("Top of this band in cents; null for the last, unbounded band."), basisPoints: bps })).min(1),
    }),
  }),
  z.object({ ...llmBase, type: z.literal("milestone_payment").describe("Fixed fee owed when a named milestone is accepted."), params: z.object({ milestone: z.string().describe("Milestone name as written, e.g. 'Milestone 1 (Brand Kit)'."), amountCents: cents }) }),
  z.object({ ...llmBase, type: z.literal("cap_minimum").describe("Ceiling (cap) or floor (minimum) on a party's total for the period."), params: z.object({ kind: z.enum(["cap", "minimum"]), amountCents: cents }) }),
  z.object({
    ...llmBase,
    type: z.literal("reserve_clawback").describe("Holdback from a party's payment: a refund reserve released later, or recoupment of an advance."),
    params: z.object({
      kind: z.enum(["reserve", "clawback"]),
      basisPoints: bps.describe("Share of the party's payment held back each period."),
      releaseAfterDays: z.number().int().min(0).nullable().describe("reserve only: days until release; null for clawback."),
      outstandingCents: cents.nullable().describe("clawback only: advance still to recoup; null for reserve."),
    }),
  }),
]);

export const LlmExtraction = z.object({
  title: z.string(),
  payer: z.string().describe("Party that collects the revenue and pays everyone else."),
  parties: z.array(Party.extend({ id: z.string().describe("Short lowercase id from the party's role, e.g. 'creator', 'designer'.") })).describe("Every party that RECEIVES money. Exclude the payer."),
  rules: z.array(LlmRule),
  unmodeledClauses: z
    .array(
      z.object({
        party: z.string().nullable().describe("Party id the clause affects, or null if it affects everyone."),
        quote: z.string().describe("Verbatim text of the clause."),
        page: z.number().int().min(1),
        reason: z.string().describe("One sentence: what it changes about payments and why the rule types above cannot express it."),
      }),
    )
    .describe("Clauses that could change WHO is paid HOW MUCH but cannot be expressed with the rule types (e.g. carry-overs, discretionary bonuses, conditions). Empty if none."),
});
export type LlmExtraction = z.infer<typeof LlmExtraction>;

export const SYSTEM_PROMPT = `You turn contracts into machine-checkable payment rules.

Rules:
- Only encode obligations the contract actually states for how money is split or paid. Skip discretionary or "may" clauses, expenses, governing law, payment timing.
- source.quote MUST be copied character-for-character from the contract: one contiguous passage, no ellipses, no paraphrase, no added words. Prefer the full sentence that states the rule.
- source.page is the number in the nearest "=== Page N ===" marker above the quote.
- Money is integer US cents. Percentages are integer basis points (5% = 500).
- A tiered split uses marginal bands: "20% up to $5,000 and 30% above" = tiers [{upToCents: 500000, basisPoints: 2000}, {upToCents: null, basisPoints: 3000}].
- A "% of each payment held in reserve" is reserve_clawback kind "reserve". Recouping an advance from a party's share is kind "clawback" with outstandingCents = the advance.
- A limit on a party's total is cap_minimum ("not exceed" = cap, "no less than" = minimum).
- One rule per obligation. Use the parties list ids in rule.party.
- confidence: 0.9+ only when the clause is unambiguous; lower it when you had to interpret.
- unmodeledClauses: list every clause that could change who is paid how much but does not fit the rule types (amounts carried to a later period, discretionary or conditional payments, offsets, etc.). Quote it verbatim. Do NOT list payment timing, currency, governing law, or clauses that only restate a rule you already encoded.`;

// ---------------------------------------------------------------------------

export type FlagCode = "QUOTE_NOT_FOUND" | "PAGE_CORRECTED" | "INVALID_RULE" | "UNKNOWN_PARTY";
export interface ExtractionFlag {
  ruleId: string | null;
  code: FlagCode;
  message: string;
}

export interface UnmodeledClause {
  id: string; // u1, u2...
  party: string | null;
  quote: string;
  page: number;
  reason: string;
  verified: boolean; // quote found verbatim in the contract
}

export interface Extraction {
  contractId: string;
  textHash: string;
  model: string;
  extractedAt: string;
  contract: ContractRules;
  flags: ExtractionFlag[];
  /** Money-affecting clauses the rule types cannot express. Missing in old caches. */
  unmodeled?: UnmodeledClause[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function contractIdFromText(text: string): string | null {
  return /Contract ID:\s*([A-Za-z0-9._-]+)/.exec(text)?.[1] ?? null;
}

/**
 * Turn raw model output into engine rules: assign ids, set status "proposed",
 * validate against the strict engine schema, and verify every quote.
 */
export function postProcess(raw: LlmExtraction, text: string, contractId: string): { contract: ContractRules; flags: ExtractionFlag[]; unmodeled: UnmodeledClause[] } {
  const flags: ExtractionFlag[] = [];
  const partyIds = new Set(raw.parties.map((p) => p.id));
  const rules: Rule[] = [];
  raw.rules.forEach((r, i) => {
    const id = `r${i + 1}`;
    let params: unknown = r.params;
    if (r.type === "reserve_clawback") {
      const p = r.params;
      params = p.kind === "reserve"
        ? { kind: "reserve", basisPoints: p.basisPoints, releaseAfterDays: p.releaseAfterDays ?? 0 }
        : { kind: "clawback", basisPoints: p.basisPoints, outstandingCents: p.outstandingCents ?? 0 };
    }
    const parsed = Rule.safeParse({ ...r, params, id, status: "proposed" });
    if (!parsed.success) {
      flags.push({ ruleId: id, code: "INVALID_RULE", message: `Dropped: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}` });
      return;
    }
    const rule = parsed.data;
    const page = findQuotePage(text, rule.source.quote);
    if (page === null) {
      rule.confidence = 0;
      flags.push({ ruleId: id, code: "QUOTE_NOT_FOUND", message: "Quote does not appear verbatim in the contract; confidence set to 0." });
    } else if (page !== rule.source.page) {
      flags.push({ ruleId: id, code: "PAGE_CORRECTED", message: `Quote is on page ${page}, not ${rule.source.page}.` });
      rule.source.page = page;
    }
    if (!partyIds.has(rule.party)) {
      flags.push({ ruleId: id, code: "UNKNOWN_PARTY", message: `Party "${rule.party}" is not in the extracted parties list.` });
    }
    rules.push(rule);
  });
  const unmodeled: UnmodeledClause[] = (raw.unmodeledClauses ?? []).map((u, i) => {
    const page = findQuotePage(text, u.quote);
    const id = `u${i + 1}`;
    if (page === null) flags.push({ ruleId: id, code: "QUOTE_NOT_FOUND", message: "Unmodeled-clause quote does not appear verbatim; kept as a warning anyway." });
    return { id, party: u.party && partyIds.has(u.party) ? u.party : null, quote: u.quote, page: page ?? u.page, reason: u.reason, verified: page !== null };
  });
  return { contract: { contractId, title: raw.title, payer: raw.payer, parties: raw.parties, rules }, flags, unmodeled };
}

export function modelName(): string {
  const m = process.env.GEMINI_MODEL;
  if (!m) throw new Error("GEMINI_MODEL is not set in .env");
  return m;
}

/** Live call to Gemini. Needs GEMINI_API_KEY and GEMINI_MODEL. */
export async function extractWithGemini(text: string, opts: { contractId?: string } = {}): Promise<Extraction> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set in .env (or run with DEMO_MODE=1 to use cached extractions)");
  const model = modelName();
  const [{ generateObject }, { createGoogleGenerativeAI }] = await Promise.all([import("ai"), import("@ai-sdk/google")]);
  const google = createGoogleGenerativeAI({ apiKey });
  const result = await generateObject({
    model: google(model),
    schema: LlmExtraction,
    schemaName: "ContractPaymentRules",
    system: SYSTEM_PROMPT,
    prompt: `Contract text:\n<<<\n${text}\n>>>`,
    temperature: 0,
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS) || 90_000),
  });
  const contractId = opts.contractId ?? contractIdFromText(text) ?? `upload-${textHash(text)}`;
  const { contract, flags, unmodeled } = postProcess(result.object, text, contractId);
  return {
    contractId,
    textHash: textHash(text),
    model,
    extractedAt: new Date().toISOString(),
    contract,
    flags,
    unmodeled,
    usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
  };
}
