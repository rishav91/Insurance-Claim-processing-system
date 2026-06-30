import type {
  AccumulatorSnapshot,
  Cents,
  CoverageRule,
  LineInput,
  Outcome,
  Override,
  Reason,
  ReasonCode,
} from "./types.js";
import {
  computeCostShare,
  type AccumulatorDelta,
  type CostShareInput,
} from "./cost-share.js";

/**
 * Facts the orchestrator gathers (from the DB) before the engine decides.
 * Keeping eligibility + duplicate detection out of the engine keeps
 * adjudicateLine a pure function over plain facts (domain-model.md §5).
 */
export interface AdjudicationContext {
  /** The coverage rule matched for the line's service type; undefined => unknown. */
  rule?: CoverageRule | undefined;
  /** Policy effective on the line's serviceDate (computed upstream). */
  coverageActive: boolean;
  /** Matches a prior non-denied line (computed upstream). */
  isDuplicate: boolean;
  accumulator: AccumulatorSnapshot;
  overrides?: Override[];
  /** Set during pended-line resolution so the engine does not pend again. */
  skipManualReview?: boolean;
}

export interface AdjudicationResult {
  outcome: Outcome;
  allowedCents: Cents;
  payableCents: Cents;
  memberResponsibilityCents: Cents;
  deductibleAppliedCents: Cents;
  memberCostShareCents: Cents;
  reasons: Reason[];
  accumulatorDelta: AccumulatorDelta;
}

const zeroDelta = (): AccumulatorDelta => ({
  deductibleMetCents: 0,
  benefitUsedCents: 0,
});

/** Hard denial (steps 1–4): no money, no accumulator effect. */
function hardDenial(code: ReasonCode, message: string): AdjudicationResult {
  return {
    outcome: "denied",
    allowedCents: 0,
    payableCents: 0,
    memberResponsibilityCents: 0,
    deductibleAppliedCents: 0,
    memberCostShareCents: 0,
    reasons: [{ code, message }],
    accumulatorDelta: zeroDelta(),
  };
}

export function adjudicateLine(
  line: LineInput,
  ctx: AdjudicationContext,
): AdjudicationResult {
  const overrides = ctx.overrides ?? [];
  const has = (t: Override["type"]): boolean => overrides.some((o) => o.type === t);

  // A parameterized override may appear at most once — two OVERRIDE_ALLOWED_AMOUNT
  // values are ambiguous (domain-model.md §5). Domain invariant, parallel to the
  // copay-XOR-coinsurance throw; the HTTP layer also rejects this at the zod edge.
  if (overrides.filter((o) => o.type === "OVERRIDE_ALLOWED_AMOUNT").length > 1) {
    throw new Error(
      "Invalid override set: at most one OVERRIDE_ALLOWED_AMOUNT may be applied",
    );
  }

  // Step 1 — validate (known service type with a matching rule).
  if (!ctx.rule || ctx.rule.serviceType !== line.serviceType) {
    return hardDenial(
      "INVALID_LINE",
      `No coverage rule for service type "${line.serviceType}"`,
    );
  }
  const rule = ctx.rule;

  // Step 2 — exclusion.
  if (rule.excluded && !has("FORCE_COVERED")) {
    return hardDenial("SERVICE_EXCLUDED", `Service "${rule.serviceType}" is excluded`);
  }

  // Step 3 — eligibility.
  if (!ctx.coverageActive && !has("MARK_ELIGIBLE")) {
    return hardDenial(
      "COVERAGE_INACTIVE",
      `Coverage was not active on ${line.serviceDate}`,
    );
  }

  // Step 4 — duplicate.
  if (ctx.isDuplicate && !has("ALLOW_DUPLICATE")) {
    return hardDenial("DUPLICATE", "Duplicate of a previously submitted line");
  }

  // Step 5 — manual review (routing, not a denial). No accumulator effect yet.
  if (rule.requiresManualReview && !ctx.skipManualReview) {
    return {
      outcome: "pended",
      allowedCents: 0,
      payableCents: 0,
      memberResponsibilityCents: 0,
      deductibleAppliedCents: 0,
      memberCostShareCents: 0,
      reasons: [
        {
          code: "PENDED_FOR_REVIEW",
          message: `Service "${rule.serviceType}" requires manual review`,
        },
      ],
      accumulatorDelta: zeroDelta(),
    };
  }

  // Steps 6–9 — money. Build the cost-share input, only setting optional keys
  // when defined (exactOptionalPropertyTypes).
  const overrideAllowed = overrides.find(
    (o): o is Extract<Override, { type: "OVERRIDE_ALLOWED_AMOUNT" }> =>
      o.type === "OVERRIDE_ALLOWED_AMOUNT",
  );
  const remainingDeductible = Math.max(
    0,
    ctx.accumulator.deductibleAnnualCents - ctx.accumulator.deductibleMetCents,
  );
  const remainingLimit =
    rule.annualLimitCents !== undefined
      ? Math.max(0, rule.annualLimitCents - ctx.accumulator.benefitUsedCents)
      : undefined;

  const csInput: CostShareInput = {
    billedCents: line.billedAmountCents,
    remainingDeductibleCents: remainingDeductible,
    waiveDeductible: has("WAIVE_DEDUCTIBLE"),
    waiveLimit: has("WAIVE_LIMIT"),
    ...(rule.allowedAmountCents !== undefined && {
      feeScheduleCents: rule.allowedAmountCents,
    }),
    ...(overrideAllowed && { overrideAllowedCents: overrideAllowed.valueCents }),
    ...(rule.copayCents !== undefined && { copayCents: rule.copayCents }),
    ...(rule.coinsuranceRate !== undefined && { coinsuranceRate: rule.coinsuranceRate }),
    ...(remainingLimit !== undefined && { remainingLimitCents: remainingLimit }),
  };

  const cs = computeCostShare(csInput);
  const reasons = [...cs.reasons];

  // Outcome from the money result:
  //  - excess denied + nothing paid → denied (limit fully exhausted, deductible still applied)
  //  - excess denied + some paid    → partially_approved
  //  - otherwise                    → approved (covered; member may still owe cost-share)
  let outcome: Outcome;
  if (cs.limitDeniedExcessCents > 0 && cs.payableCents === 0) {
    outcome = "denied";
  } else if (cs.limitDeniedExcessCents > 0) {
    outcome = "partially_approved";
  } else {
    outcome = "approved";
    reasons.push({ code: "COVERED", message: "Covered service" });
  }

  return {
    outcome,
    allowedCents: cs.allowedCents,
    payableCents: cs.payableCents,
    memberResponsibilityCents: cs.memberResponsibilityCents,
    deductibleAppliedCents: cs.deductibleAppliedCents,
    memberCostShareCents: cs.memberCostShareCents,
    reasons,
    accumulatorDelta: cs.accumulatorDelta,
  };
}
