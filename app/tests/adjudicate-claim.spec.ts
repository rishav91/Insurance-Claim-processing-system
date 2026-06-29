import { describe, it, expect } from "vitest";
import {
  adjudicateClaim,
  type ClaimLineForAdjudication,
} from "../src/domain/adjudicate-claim.js";
import type { CoverageRule } from "../src/domain/types.js";

/**
 * Behavior specs for claim-level adjudication (domain-model.md §5 "folding").
 * The blocker the review found: two lines in ONE claim that share an
 * accumulator must see each other's effect, or they double-spend a limit.
 * Plan year is keyed off serviceDate, so year-straddling lines hit DIFFERENT
 * accumulators.
 */

// PT covered at 100% (coinsurance 0) to make limit math obvious.
const ptFull: CoverageRule = {
  serviceType: "PT",
  coinsuranceRate: 0,
  annualLimitCents: 200000, // $2000/yr
};

function line(
  id: string,
  serviceDate: string,
  billedAmountCents: number,
  rule: CoverageRule = ptFull,
): ClaimLineForAdjudication {
  return {
    id,
    line: { serviceType: rule.serviceType, serviceDate, billedAmountCents },
    rule,
    coverageActive: true,
    isDuplicate: false,
  };
}

describe("adjudicateClaim — intra-claim accumulator folding", () => {
  it("two same-serviceType lines in ONE claim cannot collectively exceed the remaining annual limit", () => {
    const res = adjudicateClaim({
      lines: [
        line("a", "2026-03-01", 150000), // $1500
        line("b", "2026-03-02", 150000), // $1500 — only $500 of limit left after a
      ],
      deductibleAnnualCents: 0,
      initialDeductibleMetByYear: {},
      initialBenefitUsedByYearService: {},
    });

    const a = res.lines.find((l) => l.id === "a")!.result;
    const b = res.lines.find((l) => l.id === "b")!.result;

    expect(a.outcome).toBe("approved");
    expect(a.payableCents).toBe(150000);
    expect(b.outcome).toBe("partially_approved");
    expect(b.payableCents).toBe(50000); // capped to the remaining $500
    // Collectively never exceeds the $2000 cap:
    expect(a.payableCents + b.payableCents).toBe(200000);
    expect(res.finalBenefitUsedByYearService["2026:PT"]).toBe(200000);
  });

  it("processes lines deterministically by (serviceDate, id) regardless of input order", () => {
    const ordered = adjudicateClaim({
      lines: [line("a", "2026-03-01", 150000), line("b", "2026-03-02", 150000)],
      deductibleAnnualCents: 0,
      initialDeductibleMetByYear: {},
      initialBenefitUsedByYearService: {},
    });
    const reversed = adjudicateClaim({
      lines: [line("b", "2026-03-02", 150000), line("a", "2026-03-01", 150000)],
      deductibleAnnualCents: 0,
      initialDeductibleMetByYear: {},
      initialBenefitUsedByYearService: {},
    });
    // Same line "a" (earlier serviceDate) is paid first in both runs.
    expect(ordered.lines.find((l) => l.id === "a")!.result.payableCents).toBe(150000);
    expect(reversed.lines.find((l) => l.id === "a")!.result.payableCents).toBe(150000);
  });
});

describe("adjudicateClaim — plan year keyed by service date", () => {
  it("a claim straddling a year boundary updates two separate deductible accumulators", () => {
    // $600 annual deductible; two $500 lines, one in each year.
    const res = adjudicateClaim({
      lines: [
        line("dec", "2025-12-20", 50000),
        line("jan", "2026-01-05", 50000),
      ],
      deductibleAnnualCents: 60000,
      initialDeductibleMetByYear: {},
      initialBenefitUsedByYearService: {},
    });

    const dec = res.lines.find((l) => l.id === "dec")!.result;
    const jan = res.lines.find((l) => l.id === "jan")!.result;

    // If they SHARED an accumulator, jan would only get $100 of deductible left.
    // Keyed by service-date year, each gets its own $500 against a fresh $600.
    expect(dec.deductibleAppliedCents).toBe(50000);
    expect(jan.deductibleAppliedCents).toBe(50000);
    expect(res.finalDeductibleMetByYear[2025]).toBe(50000);
    expect(res.finalDeductibleMetByYear[2026]).toBe(50000);
  });
});

describe("adjudicateClaim — claim status rollup", () => {
  it("derives partially_approved from a mix of approved and limit-capped lines", () => {
    const res = adjudicateClaim({
      lines: [line("a", "2026-03-01", 150000), line("b", "2026-03-02", 150000)],
      deductibleAnnualCents: 0,
      initialDeductibleMetByYear: {},
      initialBenefitUsedByYearService: {},
    });
    expect(res.claimStatus).toBe("partially_approved");
  });
});
