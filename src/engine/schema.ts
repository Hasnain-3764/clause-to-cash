// Zod schemas for contract payment rules. Money is always integer cents,
// percentages are integer basis points (1% = 100 bps). No floats for money.
import { z } from "zod";

/** Upper bound for any single money value: $1B. Keeps cents * bps inside safe integers. */
export const MAX_CENTS = 100_000_000_000;

export const Cents = z.number().int().min(0).max(MAX_CENTS);
export const BasisPoints = z.number().int().min(0).max(10_000);

export const Source = z.object({
  quote: z.string().min(1).describe("Verbatim text copied from the contract that states this rule."),
  page: z.number().int().min(1).describe("Page number of the quote (from the '=== Page N ===' markers)."),
});
export type Source = z.infer<typeof Source>;

export const RuleStatus = z.enum(["proposed", "confirmed", "rejected"]);
export type RuleStatus = z.infer<typeof RuleStatus>;

const base = {
  id: z.string().min(1),
  party: z.string().min(1).describe("Party id from the contract's parties list."),
  source: Source,
  confidence: z.number().min(0).max(1),
  status: RuleStatus,
};

/** Party receives a fixed share of gross period revenue. */
export const PercentageSplitRule = z.object({
  ...base,
  type: z.literal("percentage_split"),
  params: z.object({ basisPoints: BasisPoints }),
});

/**
 * Marginal tiers on gross period revenue, like tax brackets:
 * tier i applies to revenue between the previous upToCents and this one.
 * The last tier has upToCents = null (no upper bound).
 */
export const TieredSplitRule = z.object({
  ...base,
  type: z.literal("tiered_split"),
  params: z.object({
    tiers: z
      .array(z.object({ upToCents: Cents.nullable(), basisPoints: BasisPoints }))
      .min(1)
      .superRefine((tiers, ctx) => {
        let prev = 0;
        tiers.forEach((t, i) => {
          const last = i === tiers.length - 1;
          if (t.upToCents === null && !last) ctx.addIssue({ code: "custom", message: "only the last tier may be unbounded" });
          if (t.upToCents !== null) {
            if (t.upToCents <= prev) ctx.addIssue({ code: "custom", message: "tier thresholds must increase" });
            prev = t.upToCents;
          }
        });
      }),
  }),
});

/** Fixed fee owed once the named milestone is completed. */
export const MilestonePaymentRule = z.object({
  ...base,
  type: z.literal("milestone_payment"),
  params: z.object({ milestone: z.string().min(1), amountCents: Cents }),
});

/** Ceiling or floor on a party's total for the period. */
export const CapMinimumRule = z.object({
  ...base,
  type: z.literal("cap_minimum"),
  params: z.object({ kind: z.enum(["cap", "minimum"]), amountCents: Cents }),
});

/**
 * Applied to the party's computed total for the period.
 * reserve: hold back basisPoints of it (released later, not paid now).
 * clawback: recoup up to basisPoints of it until outstandingCents is repaid.
 */
export const ReserveClawbackRule = z.object({
  ...base,
  type: z.literal("reserve_clawback"),
  params: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("reserve"), basisPoints: BasisPoints, releaseAfterDays: z.number().int().min(0) }),
    z.object({ kind: z.literal("clawback"), basisPoints: BasisPoints, outstandingCents: Cents }),
  ]),
});

export const Rule = z.discriminatedUnion("type", [
  PercentageSplitRule,
  TieredSplitRule,
  MilestonePaymentRule,
  CapMinimumRule,
  ReserveClawbackRule,
]);
export type Rule = z.infer<typeof Rule>;
export type RuleType = Rule["type"];

export const Party = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().describe("What the party does, e.g. 'creator', 'designer', 'producer'."),
  paypalEmail: z.string().nullable().describe("Payee PayPal email exactly as written in the contract, or null."),
});
export type Party = z.infer<typeof Party>;

export const ContractRules = z.object({
  contractId: z.string().min(1),
  title: z.string(),
  payer: z.string().describe("Name of the party that collects revenue and pays everyone else."),
  parties: z.array(Party),
  rules: z.array(Rule),
});
export type ContractRules = z.infer<typeof ContractRules>;
