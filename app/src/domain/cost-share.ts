import type { Cents, Reason } from "./types.js";

/**
 * The money model (domain-model.md §3). A pure function over non-PHI numbers
 * that runs steps 6–9 of the adjudication pipeline: allowed → deductible →
 * copay/coinsurance → annual limit. Every operation clamps to ≥ 0 so cost-share
 * can never exceed its base and payable can never go negative.
 *
 * Invariant: payable + memberResponsibility === allowed.
 */
export interface CostShareInput {
  billedCents: Cents;
  /** Fee schedule; allowed = min(billed, feeSchedule) when present. */
  feeScheduleCents?: Cents;
  /** Reviewer override (OVERRIDE_ALLOWED_AMOUNT) — wins over the fee schedule. */
  overrideAllowedCents?: Cents;
  /** At most ONE of copay/coinsurance. Neither => 100% coverage of the base. */
  copayCents?: Cents;
  coinsuranceRate?: number; // 0..1
  remainingDeductibleCents: Cents;
  /** undefined => no annual limit on this service type. */
  remainingLimitCents?: Cents;
  waiveDeductible?: boolean;
  waiveLimit?: boolean;
}

export interface AccumulatorDelta {
  deductibleMetCents: Cents;
  benefitUsedCents: Cents;
}

export interface CostShareResult {
  allowedCents: Cents;
  deductibleAppliedCents: Cents;
  memberCostShareCents: Cents;
  payableCents: Cents;
  limitDeniedExcessCents: Cents;
  memberResponsibilityCents: Cents;
  reasons: Reason[];
  accumulatorDelta: AccumulatorDelta;
}

const clamp0 = (n: Cents): Cents => Math.max(0, n);

export function computeCostShare(input: CostShareInput): CostShareResult {
  if (input.copayCents !== undefined && input.coinsuranceRate !== undefined) {
    throw new Error(
      "Invalid coverage rule: a rule may set at most one of copay or coinsurance",
    );
  }

  const reasons: Reason[] = [];

  // Step 6 — allowed amount (override beats fee schedule beats billed).
  let allowedCents: Cents;
  if (input.overrideAllowedCents !== undefined) {
    allowedCents = input.overrideAllowedCents;
  } else if (input.feeScheduleCents !== undefined) {
    allowedCents = Math.min(input.billedCents, input.feeScheduleCents);
  } else {
    allowedCents = input.billedCents;
  }
  if (allowedCents < input.billedCents) {
    reasons.push({
      code: "ALLOWED_REDUCED",
      message: `Billed ${input.billedCents}¢ reduced to allowed rate ${allowedCents}¢`,
      amountCents: input.billedCents - allowedCents,
    });
  }

  // Step 7 — deductible (clamped to allowed; skipped on WAIVE_DEDUCTIBLE).
  const deductibleAppliedCents = input.waiveDeductible
    ? 0
    : Math.min(allowedCents, input.remainingDeductibleCents);
  if (deductibleAppliedCents > 0) {
    reasons.push({
      code: "DEDUCTIBLE_APPLIED",
      message: `${deductibleAppliedCents}¢ applied to the remaining annual deductible`,
      amountCents: deductibleAppliedCents,
    });
  }

  const costShareBaseCents = clamp0(allowedCents - deductibleAppliedCents);

  // Step 8 — copay XOR coinsurance, clamped to the base. Neither => 0.
  let memberCostShareCents = 0;
  if (input.copayCents !== undefined) {
    memberCostShareCents = Math.min(input.copayCents, costShareBaseCents);
    reasons.push({
      code: "COPAY_APPLIED",
      message: `${memberCostShareCents}¢ member copay`,
      amountCents: memberCostShareCents,
    });
  } else if (input.coinsuranceRate !== undefined) {
    memberCostShareCents = Math.min(
      Math.round(input.coinsuranceRate * costShareBaseCents),
      costShareBaseCents,
    );
    reasons.push({
      code: "COINSURANCE_APPLIED",
      message: `${Math.round(input.coinsuranceRate * 100)}% member coinsurance on ${costShareBaseCents}¢`,
      amountCents: memberCostShareCents,
    });
  }

  const payableBeforeLimitCents = clamp0(costShareBaseCents - memberCostShareCents);

  // Step 9 — annual limit (pay up to remaining; deny the excess).
  let payableCents = payableBeforeLimitCents;
  let limitDeniedExcessCents = 0;
  const limited =
    input.remainingLimitCents !== undefined && !input.waiveLimit;
  if (limited) {
    const remaining = clamp0(input.remainingLimitCents as Cents);
    payableCents = Math.min(payableBeforeLimitCents, remaining);
    limitDeniedExcessCents = payableBeforeLimitCents - payableCents;
    if (limitDeniedExcessCents > 0) {
      if (payableCents > 0) {
        reasons.push({
          code: "PARTIALLY_PAID",
          message: `Paid ${payableCents}¢ up to the remaining annual limit`,
          amountCents: payableCents,
        });
      }
      reasons.push({
        code: "LIMIT_EXHAUSTED",
        message: `${limitDeniedExcessCents}¢ exceeds the remaining annual limit and is not covered`,
        amountCents: limitDeniedExcessCents,
      });
    }
  }

  const memberResponsibilityCents = allowedCents - payableCents;

  return {
    allowedCents,
    deductibleAppliedCents,
    memberCostShareCents,
    payableCents,
    limitDeniedExcessCents,
    memberResponsibilityCents,
    reasons,
    accumulatorDelta: {
      deductibleMetCents: deductibleAppliedCents,
      benefitUsedCents: payableCents,
    },
  };
}
