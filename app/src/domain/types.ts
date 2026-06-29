/**
 * Core domain types. All money is integer cents (no floats).
 * These types are intentionally PHI-free: the adjudication engine never sees
 * member names, dates of birth, or diagnosis codes (domain-model.md §5).
 */

export type Cents = number;
export type ServiceType = string;

/** Per-line adjudication outcome (line-item state machine, domain-model.md §4). */
export type Outcome = "approved" | "partially_approved" | "denied" | "pended";

/** Structured explanation codes — the denial/decision taxonomy (domain-model.md §5/§7). */
export type ReasonCode =
  | "INVALID_LINE"
  | "SERVICE_EXCLUDED"
  | "COVERAGE_INACTIVE"
  | "DUPLICATE"
  | "PENDED_FOR_REVIEW"
  | "ALLOWED_REDUCED"
  | "DEDUCTIBLE_APPLIED"
  | "COPAY_APPLIED"
  | "COINSURANCE_APPLIED"
  | "COVERED"
  | "PARTIALLY_PAID"
  | "LIMIT_EXHAUSTED";

export interface Reason {
  code: ReasonCode;
  message: string;
  amountCents?: Cents;
}

/** A coverage rule is data interpreted by the engine (domain-model.md §2). */
export interface CoverageRule {
  serviceType: ServiceType;
  excluded?: boolean;
  /** Optional fee schedule: allowed = min(billed, scheduled). */
  allowedAmountCents?: Cents;
  /** Cost-share: at most ONE of copay/coinsurance. Neither => 100% coverage. */
  copayCents?: Cents;
  coinsuranceRate?: number; // 0..1
  /** Max insurer-paid cents per plan year for this service type. */
  annualLimitCents?: Cents;
  requiresManualReview?: boolean;
}

/** PHI-free inputs the engine adjudicates on. */
export interface LineInput {
  serviceType: ServiceType;
  serviceDate: string; // ISO date — used upstream for plan-year + eligibility
  billedAmountCents: Cents;
}

/** Accumulator state for one (member, planYear, serviceType), read by the engine. */
export interface AccumulatorSnapshot {
  deductibleMetCents: Cents;
  deductibleAnnualCents: Cents;
  /** Insurer-paid cents so far this plan year for this service type. */
  benefitUsedCents: Cents;
}

/** Line-item lifecycle states (domain-model.md §4). */
export type LineStatus =
  | "submitted"
  | "approved"
  | "partially_approved"
  | "denied"
  | "pended"
  | "disputed"
  | "paid";

/** Derived claim lifecycle states (domain-model.md §4). */
export type ClaimStatus =
  | "submitted"
  | "under_review"
  | "approved"
  | "partially_approved"
  | "denied"
  | "paid";

/** Reviewer override directives (domain-model.md §5 taxonomy). */
export type Override =
  | { type: "FORCE_COVERED" }
  | { type: "MARK_ELIGIBLE" }
  | { type: "ALLOW_DUPLICATE" }
  | { type: "WAIVE_DEDUCTIBLE" }
  | { type: "WAIVE_LIMIT" }
  | { type: "OVERRIDE_ALLOWED_AMOUNT"; valueCents: Cents };
