import { describe, it, expect } from "vitest";
import { computeCostShare, type CostShareInput } from "../src/domain/cost-share.js";

/**
 * Behavior specs for the money model (domain-model.md §3, §7).
 * These encode the cost-sharing rules and the clamping invariants, written
 * before the implementation. The key invariant under test:
 *   payable + memberResponsibility === allowed   (for every covered line)
 */

const base: CostShareInput = {
  billedCents: 50000, // $500
  remainingDeductibleCents: 0,
};

describe("computeCostShare — cost-sharing & clamping", () => {
  it("applies a flat copay then pays the remainder when allowed exceeds the copay", () => {
    const r = computeCostShare({ ...base, copayCents: 3000 }); // $30 copay
    expect(r.allowedCents).toBe(50000);
    expect(r.memberCostShareCents).toBe(3000);
    expect(r.payableCents).toBe(47000);
    expect(r.payableCents + r.memberResponsibilityCents).toBe(r.allowedCents);
  });

  it("applies coinsurance percentage after the deductible", () => {
    const r = computeCostShare({ ...base, coinsuranceRate: 0.2 }); // 20% member
    expect(r.memberCostShareCents).toBe(10000); // 20% of $500
    expect(r.payableCents).toBe(40000); // insurer 80%
    expect(r.payableCents + r.memberResponsibilityCents).toBe(r.allowedCents);
  });

  it("pays 100% of the cost-share base when the rule has neither copay nor coinsurance", () => {
    const r = computeCostShare({ ...base }); // preventive-style: neither
    expect(r.memberCostShareCents).toBe(0);
    expect(r.payableCents).toBe(50000);
  });

  it("clamps cost-share when the copay exceeds the allowed amount (payable never negative)", () => {
    const r = computeCostShare({
      billedCents: 2000, // $20 visit
      remainingDeductibleCents: 0,
      copayCents: 3000, // $30 copay > $20 allowed
    });
    expect(r.memberCostShareCents).toBe(2000); // clamped to allowed
    expect(r.payableCents).toBe(0);
    expect(r.payableCents).toBeGreaterThanOrEqual(0);
  });

  it("when the deductible fully absorbs the allowed amount, payable is 0 and copay does not go negative", () => {
    const r = computeCostShare({
      ...base,
      remainingDeductibleCents: 100000, // $1000 deductible left, > $500 allowed
      copayCents: 3000,
    });
    expect(r.deductibleAppliedCents).toBe(50000); // whole allowed goes to deductible
    expect(r.memberCostShareCents).toBe(0); // nothing left to copay against
    expect(r.payableCents).toBe(0);
    expect(r.memberResponsibilityCents).toBe(50000);
  });

  it("reduces allowed to the fee-schedule rate and reports the reduction", () => {
    const r = computeCostShare({
      billedCents: 60000, // billed $600
      feeScheduleCents: 50000, // allowed rate $500
      remainingDeductibleCents: 0,
      coinsuranceRate: 0.2,
    });
    expect(r.allowedCents).toBe(50000);
    expect(r.reasons.map((x) => x.code)).toContain("ALLOWED_REDUCED");
  });
});

describe("computeCostShare — annual limit interaction", () => {
  it("pays a line up to the exact remaining limit and denies the excess (partial)", () => {
    const r = computeCostShare({
      billedCents: 50000, // $500
      remainingDeductibleCents: 10000, // $100 deductible left
      coinsuranceRate: 0.2,
      remainingLimitCents: 20000, // only $200 of limit left
    });
    // deductible 100, base 400, coinsurance member 80, payableBeforeLimit 320,
    // capped to remaining 200, excess 120 denied
    expect(r.deductibleAppliedCents).toBe(10000);
    expect(r.payableCents).toBe(20000);
    expect(r.limitDeniedExcessCents).toBe(12000);
    expect(r.memberResponsibilityCents).toBe(30000); // 100 + 80 + 120
    expect(r.payableCents + r.memberResponsibilityCents).toBe(r.allowedCents);
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["PARTIALLY_PAID", "LIMIT_EXHAUSTED"]),
    );
  });

  it("pays 0 when the remaining limit is 0, but still applies the deductible delta", () => {
    const r = computeCostShare({
      ...base,
      remainingDeductibleCents: 10000,
      coinsuranceRate: 0.2,
      remainingLimitCents: 0,
    });
    expect(r.payableCents).toBe(0);
    expect(r.deductibleAppliedCents).toBe(10000); // deductible-eligible spend is real
    expect(r.accumulatorDelta.deductibleMetCents).toBe(10000);
    expect(r.accumulatorDelta.benefitUsedCents).toBe(0);
  });

  it("waives the deductible when instructed (reviewer override)", () => {
    const r = computeCostShare({
      ...base,
      remainingDeductibleCents: 100000,
      coinsuranceRate: 0.2,
      waiveDeductible: true,
    });
    expect(r.deductibleAppliedCents).toBe(0);
    expect(r.payableCents).toBe(40000); // 80% of full $500
  });
});

describe("computeCostShare — validation", () => {
  it("throws when a rule sets BOTH copay and coinsurance", () => {
    expect(() =>
      computeCostShare({ ...base, copayCents: 3000, coinsuranceRate: 0.2 }),
    ).toThrow();
  });
});
