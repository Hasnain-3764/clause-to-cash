import { describe, expect, it } from "vitest";
import { allowedRecipients } from "../../src/engine/accounts";
import { allocate, centsToValue, valueToCents } from "../../src/engine/money";
import { policy } from "../../src/engine/policy";
import { findQuotePage, findQuoteRange } from "../../src/engine/quotes";
import { SAMPLE_IDS, loadContractText, loadExpectedRules } from "../../src/engine/samples";
import type { Rule } from "../../src/engine/schema";
import { naiveEqualSplit, simulate } from "../../src/engine/simulate";

const run = (id: (typeof SAMPLE_IDS)[number], revenue: number, completedMilestones: string[] = []) => {
  const c = loadExpectedRules(id);
  const s = simulate(c.rules, revenue, { parties: c.parties, completedMilestones });
  const decide = (rules: Rule[] = c.rules) =>
    Object.fromEntries(s.lines.map((l) => [l.party, policy(l, { rules, simulation: s, allowedRecipients: allowedRecipients(), approvalThresholdCents: 100_000 })]));
  return { c, s, amounts: Object.fromEntries(s.lines.map((l) => [l.party, l.amountCents])), decide };
};

describe("sample contracts", () => {
  for (const id of SAMPLE_IDS) {
    it(`${id}: every expected quote appears verbatim on its stated page`, () => {
      const text = loadContractText(id);
      for (const r of loadExpectedRules(id).rules) {
        expect(findQuotePage(text, r.source.quote), r.id).toBe(r.source.page);
        expect(findQuoteRange(text, r.source.quote), r.id).not.toBeNull();
      }
      expect(findQuotePage(text, "The Studio shall pay everyone double.")).toBeNull();
    });
  }

  it("creator-collab @ $8,000: tiered 20%/30% split, 10% creator reserve, 5% editor", () => {
    const { s, amounts, decide } = run("creator-collab", 800_000);
    expect(amounts).toEqual({ creator: 171_000, editor: 40_000 });
    expect(s.reserveCents).toBe(19_000);
    expect(s.retainedCents).toBe(570_000);
    const d = decide();
    expect(d.creator.decision).toBe("needs_approval"); // $1,710 > $1,000 threshold
    expect(d.creator.reasons.map((r) => r.code)).toEqual(["OVER_THRESHOLD"]);
    expect(d.editor.decision).toBe("allow");
  });

  it("agency-freelancer @ $4,000, both milestones: designer capped at $3,000", () => {
    const { s, amounts } = run("agency-freelancer", 400_000, ["Milestone 1 (Brand Kit)", "Milestone 2 (Website Launch)"]);
    expect(amounts).toEqual({ designer: 300_000, copywriter: 32_000 });
    expect(s.retainedCents).toBe(68_000);
    expect(s.warnings.map((w) => w.code)).toContain("CAP_APPLIED");
  });

  it("agency-freelancer @ $2,000, milestone 1 only: copywriter topped up to $250 minimum", () => {
    const { s, amounts } = run("agency-freelancer", 200_000, ["Milestone 1 (Brand Kit)"]);
    expect(amounts).toEqual({ designer: 150_000, copywriter: 25_000 });
    expect(s.retainedCents).toBe(25_000);
    expect(s.warnings.map((w) => w.code)).toContain("MINIMUM_APPLIED");
  });

  it("music-split @ $1,000: artist clawback 50%, guitarist denied (not a sandbox account)", () => {
    const { s, amounts, decide } = run("music-split", 100_000);
    expect(amounts).toEqual({ artist: 25_000, producer: 30_000, guitarist: 5_000 });
    expect(s.recoupedCents).toBe(25_000);
    expect(s.retainedCents).toBe(40_000);
    const d = decide();
    expect(d.guitarist.decision).toBe("deny");
    expect(d.guitarist.reasons[0].code).toBe("RECIPIENT_NOT_ALLOWED");
    expect(d.artist.decision).toBe("allow");
  });

  it("music-split: clawback stops once the advance is recouped", () => {
    const { amounts, s } = run("music-split", 1_000_000); // artist share $5,000, half is $2,500 > $1,000 left
    expect(s.recoupedCents).toBe(100_000);
    expect(amounts.artist).toBe(400_000);
  });

  it("policy: rejecting a rule after simulation denies the stale line", () => {
    const { c, decide } = run("music-split", 100_000);
    const rules = c.rules.map((r) => (r.id === "r2" ? { ...r, status: "rejected" as const } : r));
    expect(decide(rules).producer.decision).toBe("deny");
    expect(decide(rules).producer.reasons.map((r) => r.code)).toEqual(["RULE_REJECTED"]);
  });

  it("policy: low confidence needs approval until confirmed", () => {
    const { c, decide } = run("music-split", 100_000);
    const low = c.rules.map((r) => (r.id === "r2" ? { ...r, confidence: 0.5 } : r));
    expect(decide(low).producer.decision).toBe("needs_approval");
    const confirmed = low.map((r) => (r.id === "r2" ? { ...r, status: "confirmed" as const } : r));
    expect(decide(confirmed).producer.decision).toBe("allow");
  });

  it("policy: payouts exceeding revenue are denied", () => {
    const { s, c } = run("music-split", 100_000);
    const tampered = { ...s, lines: s.lines.map((l) => (l.party === "producer" ? { ...l, amountCents: 90_000 } : l)) };
    const p = policy(tampered.lines[1], { rules: c.rules, simulation: tampered, allowedRecipients: allowedRecipients(), approvalThresholdCents: 100_000 });
    expect(p.decision).toBe("deny");
    expect(p.reasons.map((r) => r.code)).toContain("PAYOUTS_EXCEED_REVENUE");
  });

  it("conflicting share rules for one party need approval", () => {
    const c = loadExpectedRules("music-split");
    const rules: Rule[] = [...c.rules, { ...c.rules[1], id: "dup", params: { basisPoints: 2500 } } as Rule];
    const s = simulate(rules, 100_000, { parties: c.parties });
    const producer = s.lines.find((l) => l.party === "producer")!;
    expect(producer.conflicts).toEqual(["CONFLICT_MULTIPLE_SHARES", "OVERALLOCATED", "SHARES_EXCEED_100_PERCENT"]);
    expect(policy(producer, { rules, simulation: s, allowedRecipients: allowedRecipients(), approvalThresholdCents: 100_000 }).decision).toBe("needs_approval");
  });

  it("naive equal split vs contract split", () => {
    expect([...naiveEqualSplit(100_000, ["a", "b", "c"]).values()]).toEqual([33_334, 33_333, 33_333]);
  });
});

describe("money helpers", () => {
  it("allocate + cents formatting", () => {
    expect(allocate(100, [1n, 1n, 1n])).toEqual([34, 33, 33]);
    expect(centsToValue(171_000)).toBe("1710.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(valueToCents("10.5")).toBe(1050);
    expect(() => valueToCents("1.234")).toThrow();
  });
});
