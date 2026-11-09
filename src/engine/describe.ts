// Human-readable rule summaries (shared by CLI and UI).
import { formatUSD } from "./money";
import type { Rule } from "./schema";

const pct = (b: number) => `${b / 100}%`;

export const RULE_LABEL: Record<Rule["type"], string> = {
  percentage_split: "Percentage split",
  tiered_split: "Tiered split",
  milestone_payment: "Milestone payment",
  cap_minimum: "Cap / minimum",
  reserve_clawback: "Reserve / clawback",
};

export function describeRule(r: Rule): string {
  switch (r.type) {
    case "percentage_split":
      return `${pct(r.params.basisPoints)} of revenue`;
    case "tiered_split": {
      let prev = 0;
      return r.params.tiers
        .map((t) => {
          const s = t.upToCents === null ? `${pct(t.basisPoints)} above ${formatUSD(prev)}` : `${pct(t.basisPoints)} of ${formatUSD(prev)}–${formatUSD(t.upToCents)}`;
          if (t.upToCents !== null) prev = t.upToCents;
          return s;
        })
        .join(", ");
    }
    case "milestone_payment":
      return `${formatUSD(r.params.amountCents)} when "${r.params.milestone}" is accepted`;
    case "cap_minimum":
      return `${r.params.kind === "cap" ? "At most" : "At least"} ${formatUSD(r.params.amountCents)} per period`;
    case "reserve_clawback":
      return r.params.kind === "reserve"
        ? `Hold ${pct(r.params.basisPoints)} of each payment for ${r.params.releaseAfterDays} days`
        : `Withhold ${pct(r.params.basisPoints)} of each payment until ${formatUSD(r.params.outstandingCents)} advance is recouped`;
  }
}
