import { describe, it, expect } from "vitest";
import {
  adjudicateLine,
  type AdjudicationContext,
} from "../src/domain/adjudicate.js";
import type { CoverageRule, LineInput } from "../src/domain/types.js";

/**
 * Behavior specs for the per-line adjudication pipeline (domain-model.md §5).
 * The engine decides the OUTCOME given facts the orchestrator gathers
 * (matched rule, coverage-active, duplicate). It must:
 *  - hard-deny (steps 1–4) with NO accumulator delta and allowed=0
 *  - pend on requiresManualReview with NO delta
 *  - run the money engine (steps 6–9) for covered lines
 *  - honor reviewer overrides
 */

const line: LineInput = {
  serviceType: "PT",
  serviceDate: "2026-03-01",
  billedAmountCents: 50000, // $500
};

const ptRule: CoverageRule = {
  serviceType: "PT",
  coinsuranceRate: 0.2,
  annualLimitCents: 200000, // $2000/yr
};

function ctx(over: Partial<AdjudicationContext> = {}): AdjudicationContext {
  return {
    rule: ptRule,
    coverageActive: true,
    isDuplicate: false,
    accumulator: {
      deductibleMetCents: 100000, // deductible already met → no deductible left
      deductibleAnnualCents: 100000,
      benefitUsedCents: 0,
    },
    overrides: [],
    ...over,
  };
}

describe("adjudicateLine — hard denials (steps 1–4)", () => {
  it("denies an unknown service type as INVALID_LINE with no accumulator delta", () => {
    const r = adjudicateLine(line, ctx({ rule: undefined }));
    expect(r.outcome).toBe("denied");
    expect(r.reasons[0]?.code).toBe("INVALID_LINE");
    expect(r.allowedCents).toBe(0);
    expect(r.payableCents).toBe(0);
    expect(r.accumulatorDelta).toEqual({
      deductibleMetCents: 0,
      benefitUsedCents: 0,
    });
  });

  it("denies an excluded service as SERVICE_EXCLUDED", () => {
    const r = adjudicateLine(line, ctx({ rule: { serviceType: "PT", excluded: true } }));
    expect(r.outcome).toBe("denied");
    expect(r.reasons[0]?.code).toBe("SERVICE_EXCLUDED");
    expect(r.accumulatorDelta.deductibleMetCents).toBe(0);
  });

  it("denies when coverage is inactive on the service date", () => {
    const r = adjudicateLine(line, ctx({ coverageActive: false }));
    expect(r.outcome).toBe("denied");
    expect(r.reasons[0]?.code).toBe("COVERAGE_INACTIVE");
  });

  it("denies a duplicate line", () => {
    const r = adjudicateLine(line, ctx({ isDuplicate: true }));
    expect(r.outcome).toBe("denied");
    expect(r.reasons[0]?.code).toBe("DUPLICATE");
  });
});

describe("adjudicateLine — manual review (step 5)", () => {
  it("pends a line whose rule requires manual review, with no accumulator delta", () => {
    const r = adjudicateLine(
      line,
      ctx({ rule: { serviceType: "PT", requiresManualReview: true } }),
    );
    expect(r.outcome).toBe("pended");
    expect(r.reasons[0]?.code).toBe("PENDED_FOR_REVIEW");
    expect(r.accumulatorDelta).toEqual({
      deductibleMetCents: 0,
      benefitUsedCents: 0,
    });
  });

  it("does NOT pend again during resolution (skipManualReview)", () => {
    const r = adjudicateLine(
      line,
      ctx({
        rule: { serviceType: "PT", requiresManualReview: true, coinsuranceRate: 0.2 },
        skipManualReview: true,
      }),
    );
    expect(r.outcome).toBe("approved");
  });
});

describe("adjudicateLine — covered outcomes (steps 6–9)", () => {
  it("approves a fully covered line and emits COVERED", () => {
    const r = adjudicateLine(line, ctx());
    expect(r.outcome).toBe("approved");
    expect(r.payableCents).toBe(40000); // 80% of $500, deductible already met
    expect(r.reasons.map((x) => x.code)).toContain("COVERED");
    expect(r.accumulatorDelta.benefitUsedCents).toBe(40000);
  });

  it("partially approves when the line exceeds the remaining annual limit", () => {
    const r = adjudicateLine(
      line,
      ctx({
        accumulator: {
          deductibleMetCents: 100000,
          deductibleAnnualCents: 100000,
          benefitUsedCents: 180000, // $1800 used of $2000 → $200 left
        },
      }),
    );
    expect(r.outcome).toBe("partially_approved");
    expect(r.payableCents).toBe(20000);
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["PARTIALLY_PAID", "LIMIT_EXHAUSTED"]),
    );
  });

  it("denies (not partial) when remaining limit is 0, but still applies the deductible delta", () => {
    const r = adjudicateLine(
      line,
      ctx({
        accumulator: {
          deductibleMetCents: 90000, // $100 deductible left
          deductibleAnnualCents: 100000,
          benefitUsedCents: 200000, // limit fully used
        },
      }),
    );
    expect(r.outcome).toBe("denied");
    expect(r.payableCents).toBe(0);
    expect(r.accumulatorDelta.deductibleMetCents).toBe(10000); // deductible still consumed
    expect(r.accumulatorDelta.benefitUsedCents).toBe(0);
  });
});

describe("adjudicateLine — reviewer overrides", () => {
  it("FORCE_COVERED overrides an exclusion", () => {
    const r = adjudicateLine(
      line,
      ctx({
        rule: { serviceType: "PT", excluded: true, coinsuranceRate: 0.2 },
        overrides: [{ type: "FORCE_COVERED" }],
      }),
    );
    expect(r.outcome).toBe("approved");
  });

  it("WAIVE_LIMIT pays beyond the exhausted annual cap", () => {
    const r = adjudicateLine(
      line,
      ctx({
        accumulator: {
          deductibleMetCents: 100000,
          deductibleAnnualCents: 100000,
          benefitUsedCents: 200000, // limit used
        },
        overrides: [{ type: "WAIVE_LIMIT" }],
      }),
    );
    expect(r.outcome).toBe("approved");
    expect(r.payableCents).toBe(40000);
  });

  it("OVERRIDE_ALLOWED_AMOUNT sets the allowed amount", () => {
    const r = adjudicateLine(
      line,
      ctx({ overrides: [{ type: "OVERRIDE_ALLOWED_AMOUNT", valueCents: 30000 }] }),
    );
    expect(r.allowedCents).toBe(30000);
    expect(r.payableCents).toBe(24000); // 80% of $300
  });
});
