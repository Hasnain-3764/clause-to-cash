import fc from "fast-check";
import type { Party, Rule } from "../../src/engine/schema";

export const PARTIES = ["p0", "p1", "p2", "p3"];
export const MILESTONES = ["m1", "m2", "m3"];

const common = {
  party: fc.constantFrom(...PARTIES),
  source: fc.constant({ quote: "q", page: 1 }),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  status: fc.constantFrom("proposed" as const, "confirmed" as const, "rejected" as const),
};
const cents = fc.integer({ min: 0, max: 10_000_000 });
const bps = fc.integer({ min: 0, max: 10_000 });

const tiers = fc
  .uniqueArray(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 0, maxLength: 3 })
  .chain((ts) => {
    const sorted = [...ts].sort((a, b) => a - b);
    return fc.tuple(...[...sorted, null].map((up) => fc.record({ upToCents: fc.constant(up), basisPoints: bps })));
  });

const ruleNoId: fc.Arbitrary<Omit<Rule, "id">> = fc.oneof(
  fc.record({ ...common, type: fc.constant("percentage_split" as const), params: fc.record({ basisPoints: bps }) }),
  fc.record({ ...common, type: fc.constant("tiered_split" as const), params: fc.record({ tiers }) }),
  fc.record({ ...common, type: fc.constant("milestone_payment" as const), params: fc.record({ milestone: fc.constantFrom(...MILESTONES), amountCents: cents }) }),
  fc.record({ ...common, type: fc.constant("cap_minimum" as const), params: fc.record({ kind: fc.constantFrom("cap" as const, "minimum" as const), amountCents: cents }) }),
  fc.record({
    ...common,
    type: fc.constant("reserve_clawback" as const),
    params: fc.oneof(
      fc.record({ kind: fc.constant("reserve" as const), basisPoints: bps, releaseAfterDays: fc.integer({ min: 0, max: 365 }) }),
      fc.record({ kind: fc.constant("clawback" as const), basisPoints: bps, outstandingCents: cents }),
    ),
  }),
) as fc.Arbitrary<Omit<Rule, "id">>;

export const rulesArb: fc.Arbitrary<Rule[]> = fc
  .array(ruleNoId, { maxLength: 10 })
  .map((rs) => rs.map((r, i) => ({ ...r, id: `r${i}` }) as Rule));

export const revenueArb = fc.oneof(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 10_000_000_000 }));
export const milestonesArb = fc.subarray(MILESTONES);

export const parties: Party[] = PARTIES.map((id, i) => ({
  id,
  name: id,
  role: "payee",
  paypalEmail: i < 3 ? `${id}@personal.example.com` : null,
}));
export const allowed = new Set(["p0@personal.example.com", "p1@personal.example.com"]);
