/**
 * Orchestration service (roadmap Phase 3): wires the pure engine to the database.
 * This is where the "gather facts" work lives — rule matching, eligibility,
 * duplicate detection, ledger summing — all I/O the PHI-free engine must not do.
 *
 * The engine (`src/domain/`) stays pure; this layer loads inputs, calls it, and
 * persists results + ledger entries + events inside one serialized transaction.
 */
import type { ClaimStatus, LineStatus, Reason } from "../domain/types.js";

export interface SubmitLineInput {
  serviceType: string;
  serviceDate: string;
  billedAmountCents: number;
  diagnosisCode?: string;
}

export interface SubmitClaimInput {
  memberId: string;
  providerId: string;
  lines: SubmitLineInput[];
}

/** A line with its (possibly not-yet-computed) adjudication breakdown. */
export interface LineView {
  id: string;
  serviceType: string;
  serviceDate: string;
  billedAmountCents: number;
  status: LineStatus;
  allowedCents: number | null;
  payableCents: number | null;
  memberResponsibilityCents: number | null;
  deductibleAppliedCents: number | null;
  memberCostShareCents: number | null;
  reasons: Reason[];
}

export interface EventView {
  type: string;
  lineItemId: string | null;
  fromState: string | null;
  toState: string | null;
  actor: string;
  note: string | null;
  createdAt: Date;
}

/** The read model the API serializes — claim + derived status + lines + timeline. */
export interface ClaimView {
  id: string;
  memberId: string;
  providerId: string;
  status: ClaimStatus; // DERIVED from line states, never stored
  submittedAt: Date;
  paidAmountCents: number | null;
  paidAt: Date | null;
  lineItems: LineView[];
  events: EventView[];
}

export function submitClaim(_input: SubmitClaimInput): Promise<ClaimView> {
  throw new Error("submitClaim() not implemented");
}

export function getClaim(_claimId: string): Promise<ClaimView | null> {
  throw new Error("getClaim() not implemented");
}

export function adjudicateClaim(_claimId: string): Promise<ClaimView> {
  throw new Error("adjudicateClaim() not implemented");
}
