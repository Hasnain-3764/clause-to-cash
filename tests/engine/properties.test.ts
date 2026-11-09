import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { batchIdempotencyKey } from "../../src/engine/idempotency";
import { allocate, sum } from "../../src/engine/money";
import { policy } from "../../src/engine/policy";
import { Rule } from "../../src/engine/schema";
import { simulate } from "../../src/engine/simulate";
import { allowed, milestonesArb, parties, revenueArb, rulesArb } from "./arbitraries";

const RUNS = { numRuns: 2000 };

describe("property: simulate", () => {
  it("generated rules are valid against the zod schema", () => {
    fc.assert(fc.property(rulesArb, (rules) => { for (const r of rules) Rule.parse(r); }), { numRuns: 300 });
  });

  it("payouts + reserve never exceed revenue, and everything sums to revenue exactly", () => {
    fc.assert(
      fc.property(rulesArb, revenueArb, milestonesArb, (rules, revenue, done) => {
        const s = simulate(rules, revenue, { parties, completedMilestones: done });
        const paid = sum(s.lines.map((l) => l.amountCents));
        expect(paid + s.reserveCents).toBeLessThanOrEqual(revenue);
        expect(paid + s.reserveCents + s.retainedCents).toBe(revenue);
        for (const l of s.lines) {
          expect(Number.isSafeInteger(l.amountCents)).toBe(true);
          expect(l.amountCents).toBeGreaterThan(0);
          expect(l.amountCents + l.reserveCents + l.recoupedCents).toBe(l.grossCents);
        }
        expect(s.retainedCents).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it("percentage splits that add to 100% pay out revenue to the cent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 6 }),
        revenueArb,
        (weights, revenue) => {
          // Turn arbitrary weights into basis points that sum to exactly 10000.
          const bps = allocate(10_000, weights.map(BigInt));
          const rules: Rule[] = bps.map((b, i) => ({
            id: `r${i}`, type: "percentage_split", party: `x${i}`, params: { basisPoints: b },
            source: { quote: "q", page: 1 }, confidence: 1, status: "confirmed",
          }));
          const s = simulate(rules, revenue);
          expect(sum(s.lines.map((l) => l.amountCents))).toBe(revenue);
          expect(s.retainedCents).toBe(0);
          // Each line is within one cent of its exact share.
          for (const l of s.lines) {
            const i = Number(l.party.slice(1));
            expect(Math.abs(l.amountCents * 10_000 - revenue * bps[i])).toBeLessThan(10_000);
          }
        },
      ),
      RUNS,
    );
  });

  it("caps are never breached", () => {
    fc.assert(
      fc.property(rulesArb, revenueArb, milestonesArb, (rules, revenue, done) => {
        const s = simulate(rules, revenue, { parties, completedMilestones: done });
        for (const l of s.lines) {
          const caps = rules.filter((r) => r.status !== "rejected" && r.party === l.party && r.type === "cap_minimum" && r.params.kind === "cap");
          for (const c of caps) {
            if (c.type !== "cap_minimum") continue;
            expect(l.grossCents).toBeLessThanOrEqual(c.params.amountCents);
            expect(l.amountCents).toBeLessThanOrEqual(c.params.amountCents);
          }
        }
      }),
      RUNS,
    );
  });

  it("rejected rules never contribute to a payout", () => {
    fc.assert(
      fc.property(rulesArb, revenueArb, milestonesArb, (rules, revenue, done) => {
        const s = simulate(rules, revenue, { parties, completedMilestones: done });
        const rejected = new Set(rules.filter((r) => r.status === "rejected").map((r) => r.id));
        for (const l of s.lines) for (const b of l.breakdown) expect(rejected.has(b.ruleId)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe("property: policy", () => {
  it("same input gives the same decision", () => {
    fc.assert(
      fc.property(rulesArb, revenueArb, milestonesArb, fc.integer({ min: 0, max: 1_000_000 }), (rules, revenue, done, threshold) => {
        const run = () => {
          const s = simulate(structuredClone(rules), revenue, { parties, completedMilestones: done });
          return s.lines.map((l) => policy(l, { rules, simulation: s, allowedRecipients: allowed, approvalThresholdCents: threshold }));
        };
        expect(run()).toEqual(run());
      }),
      { numRuns: 500 },
    );
  });

  it("deny beats needs_approval beats allow", () => {
    fc.assert(
      fc.property(rulesArb, revenueArb, milestonesArb, fc.integer({ min: 0, max: 1_000_000 }), (rules, revenue, done, threshold) => {
        const s = simulate(rules, revenue, { parties, completedMilestones: done });
        for (const l of s.lines) {
          const p = policy(l, { rules, simulation: s, allowedRecipients: allowed, approvalThresholdCents: threshold });
          const deny = p.reasons.some((r) => ["PAYOUTS_EXCEED_REVENUE", "RECIPIENT_NOT_ALLOWED", "RULE_REJECTED", "RULE_MISSING", "INVALID_AMOUNT"].includes(r.code));
          expect(p.decision).toBe(deny ? "deny" : p.reasons.length ? "needs_approval" : "allow");
          if (!l.receiver || !allowed.has(l.receiver)) expect(p.decision).toBe("deny");
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("property: batch idempotency key", () => {
  const lineArb = fc.record({ receiver: fc.emailAddress(), amountCents: fc.integer({ min: 1, max: 1e9 }) });
  it("is stable under any reordering of lines", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.array(lineArb, { maxLength: 8 }), fc.infiniteStream(fc.double()), (cid, period, lines, rnd) => {
        const shuffled = lines.map((l) => ({ l, k: rnd.next().value })).sort((a, b) => a.k - b.k).map((x) => x.l);
        expect(batchIdempotencyKey(cid, period, shuffled)).toBe(batchIdempotencyKey(cid, period, lines));
      }),
      RUNS,
    );
  });
  it("changes when an amount, period or contract changes", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.array(lineArb, { minLength: 1, maxLength: 8 }), (cid, period, lines) => {
        const k = batchIdempotencyKey(cid, period, lines);
        const bumped = lines.map((l, i) => (i === 0 ? { ...l, amountCents: l.amountCents + 1 } : l));
        expect(batchIdempotencyKey(cid, period, bumped)).not.toBe(k);
        expect(batchIdempotencyKey(cid, period + "x", lines)).not.toBe(k);
        expect(batchIdempotencyKey(cid + "x", period, lines)).not.toBe(k);
        expect(k).toMatch(/^c2c-[0-9a-f]{40}$/);
      }),
      { numRuns: 500 },
    );
  });
});
