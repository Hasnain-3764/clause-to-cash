import { describe, expect, it } from "vitest";
import { getExtraction, readCached } from "../src/ai/cache";
import { postProcess, type LlmExtraction } from "../src/ai/extract";
import { scoreExtraction } from "../src/ai/score";
import { allowedRecipients } from "../src/engine/accounts";
import { policy } from "../src/engine/policy";
import { SAMPLE_IDS, loadContractText, loadExpectedRules } from "../src/engine/samples";
import { simulate } from "../src/engine/simulate";

const text = loadContractText("music-split");
const parties = loadExpectedRules("music-split").parties;
const src = (quote: string, page = 1) => ({ quote, page });

describe("postProcess (quote verification)", () => {
  const raw: LlmExtraction = {
    title: "t",
    payer: "Lantern Row Records",
    parties,
    rules: [
      { type: "percentage_split", party: "artist", params: { basisPoints: 5000 }, source: src("The Artist shall receive fifty percent (50%) of Gross Receipts."), confidence: 0.95 },
      // Hallucinated: paraphrased, not in the contract.
      { type: "percentage_split", party: "producer", params: { basisPoints: 4000 }, source: src("The Producer gets 40% of all receipts."), confidence: 0.9 },
      // Right quote, wrong page.
      { type: "reserve_clawback", party: "artist", params: { kind: "clawback", basisPoints: 5000, outstandingCents: 100000, releaseAfterDays: null }, source: src("The advance is recoupable", 1), confidence: 0.9 },
      // Invalid: tiers out of order.
      { type: "tiered_split", party: "producer", params: { tiers: [{ upToCents: 500, basisPoints: 1 }, { upToCents: 100, basisPoints: 2 }] }, source: src("x"), confidence: 0.5 },
      { type: "percentage_split", party: "drummer", params: { basisPoints: 100 }, source: src("The Guitarist shall receive five percent (5%) of Gross Receipts."), confidence: 0.9 },
    ],
    unmodeledClauses: [
      { party: "producer", quote: "No other advance is recoupable from the Producer or the Guitarist.", page: 2, reason: "test" },
      { party: "ghost", quote: "The Label may pay a surprise bonus.", page: 1, reason: "invented" },
    ],
  };
  const { contract, flags, unmodeled } = postProcess(raw, text, "music-split-003");
  const codes = flags.map((f) => `${f.ruleId}:${f.code}`);

  it("flags a quote that is not in the contract and zeroes its confidence", () => {
    expect(codes).toContain("r2:QUOTE_NOT_FOUND");
    expect(contract.rules.find((r) => r.id === "r2")!.confidence).toBe(0);
    expect(contract.rules.find((r) => r.id === "r1")!.confidence).toBe(0.95);
  });
  it("corrects a wrong page, drops invalid rules, flags unknown parties", () => {
    expect(codes).toContain("r3:PAGE_CORRECTED");
    expect(contract.rules.find((r) => r.id === "r3")!.source.page).toBe(2);
    expect(codes).toContain("r4:INVALID_RULE");
    expect(contract.rules.some((r) => r.id === "r4")).toBe(false);
    expect(codes).toContain("r5:UNKNOWN_PARTY");
    expect(contract.rules.every((r) => r.status === "proposed")).toBe(true);
  });
  it("verifies unmodeled-clause quotes and maps unknown parties to everyone", () => {
    expect(unmodeled.map((u) => [u.id, u.party, u.verified])).toEqual([["u1", "producer", true], ["u2", null, false]]);
    expect(codes).toContain("u2:QUOTE_NOT_FOUND");
  });

  it("an unmodeled clause sends that party's payout to approval", () => {
    const c = loadExpectedRules("music-split");
    const s = simulate(c.rules, 100_000, { parties: c.parties });
    const ctx = { rules: c.rules, simulation: s, allowedRecipients: allowedRecipients(), approvalThresholdCents: 100_000, openClauses: [{ id: "u1", party: "producer", reason: "carry-over" }] };
    const by = Object.fromEntries(s.lines.map((l) => [l.party, policy(l, ctx)]));
    expect(by.producer.decision).toBe("needs_approval");
    expect(by.producer.reasons.map((r) => r.code)).toEqual(["UNMODELED_CLAUSE"]);
    expect(by.artist.decision).toBe("allow");
    expect(by.guitarist.decision).toBe("deny"); // deny still wins
  });

  it("a hallucinated rule can never be paid without human approval", () => {
    const s = simulate(contract.rules, 100_000, { parties: contract.parties });
    const producer = s.lines.find((l) => l.party === "producer")!;
    const p = policy(producer, { rules: contract.rules, simulation: s, allowedRecipients: allowedRecipients(), approvalThresholdCents: 100_000 });
    expect(p.decision).toBe("needs_approval");
    expect(p.reasons.map((r) => r.code)).toContain("LOW_CONFIDENCE");
  });
});

describe("cached extractions (what DEMO_MODE uses)", () => {
  for (const id of SAMPLE_IDS) {
    it(`${id}: cache exists, matches the contract text, and scores 100% against expected rules`, async () => {
      const cached = readCached(id);
      expect(cached, "run `npm run extract` to create it").not.toBeNull();
      process.env.DEMO_MODE = "1";
      const { extraction, fromCache } = await getExtraction(loadContractText(id), id);
      delete process.env.DEMO_MODE;
      expect(fromCache).toBe(true);
      expect(extraction.flags.filter((f) => f.code === "QUOTE_NOT_FOUND")).toEqual([]);
      const s = scoreExtraction(loadExpectedRules(id), extraction.contract, [80_000, 800_000, 2_500_000], { allMilestonesDone: true });
      expect(s.missing).toEqual([]);
      expect(s.payoutChecks.every((c) => c.same)).toBe(true);
    });
  }
  it("the cached extractions flag the rollover and discretionary-bonus clauses", () => {
    const u = (id: string) => (readCached(id)?.unmodeled ?? []).map((x) => ({ party: x.party, verified: x.verified, rollover: /rolls over/.test(x.quote), bonus: /bonus/.test(x.quote) }));
    expect(u("agency-freelancer")).toContainEqual({ party: "designer", verified: true, rollover: true, bonus: false });
    expect(u("creator-collab")).toContainEqual({ party: "creator", verified: true, rollover: false, bonus: true });
  });

  it("DEMO_MODE refuses a live call for text it has never seen", async () => {
    process.env.DEMO_MODE = "1";
    await expect(getExtraction("=== Page 1 ===\nA brand new contract.", "new")).rejects.toThrow(/DEMO_MODE/);
    delete process.env.DEMO_MODE;
  });
});
