/**
 * Orchestration service (roadmap Phase 3): wires the pure engine to the database.
 * This is where the "gather facts" work lives — rule matching, eligibility,
 * duplicate detection, ledger summing — all I/O the PHI-free engine must not do.
 *
 * The engine (`src/domain/`) stays pure; this layer loads inputs, calls it, and
 * persists results + ledger entries + events inside one serialized transaction.
 */
import type { Claim, Event, LineItem } from "@prisma/client";
import type { ClaimStatus, LineStatus, Reason } from "../domain/types.js";
import { deriveClaimStatus } from "../domain/claim-status.js";
import { prisma } from "../db/client.js";

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

// ── View mappers ───────────────────────────────────────────────────────────

function parseReasons(json: string | null): Reason[] {
  return json ? (JSON.parse(json) as Reason[]) : [];
}

function toLineView(l: LineItem): LineView {
  return {
    id: l.id,
    serviceType: l.serviceType,
    serviceDate: l.serviceDate,
    billedAmountCents: l.billedAmountCents,
    status: l.status as LineStatus,
    allowedCents: l.allowedCents,
    payableCents: l.payableCents,
    memberResponsibilityCents: l.memberResponsibilityCents,
    deductibleAppliedCents: l.deductibleAppliedCents,
    memberCostShareCents: l.memberCostShareCents,
    reasons: parseReasons(l.reasons),
  };
}

function toClaimView(claim: Claim & { lineItems: LineItem[]; events: Event[] }): ClaimView {
  const lineItems = claim.lineItems.map(toLineView);
  return {
    id: claim.id,
    memberId: claim.memberId,
    providerId: claim.providerId,
    // Claim status is DERIVED from the line states — never read from a column (§4).
    status: deriveClaimStatus(lineItems.map((l) => l.status)),
    submittedAt: claim.submittedAt,
    paidAmountCents: claim.paidAmountCents,
    paidAt: claim.paidAt,
    lineItems,
    events: claim.events.map((e) => ({
      type: e.type,
      lineItemId: e.lineItemId,
      fromState: e.fromState,
      toState: e.toState,
      actor: e.actor,
      note: e.note,
      createdAt: e.createdAt,
    })),
  };
}

// ── Service functions ────────────────────────────────────────────────────────

/** Two-step flow, step 1: persist the claim as `submitted`. No adjudication. */
export async function submitClaim(input: SubmitClaimInput): Promise<ClaimView> {
  const claim = await prisma.$transaction(async (tx) => {
    const created = await tx.claim.create({
      data: {
        memberId: input.memberId,
        providerId: input.providerId,
        lineItems: {
          create: input.lines.map((l) => ({
            serviceType: l.serviceType,
            serviceDate: l.serviceDate,
            billedAmountCents: l.billedAmountCents,
            ...(l.diagnosisCode !== undefined && { diagnosisCode: l.diagnosisCode }),
          })),
        },
      },
    });
    await tx.event.create({
      data: {
        claimId: created.id,
        type: "SUBMITTED",
        toState: "submitted",
        actor: "member",
      },
    });
    return created;
  });

  return (await getClaim(claim.id))!;
}

export async function getClaim(claimId: string): Promise<ClaimView | null> {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    include: {
      lineItems: { orderBy: [{ serviceDate: "asc" }, { id: "asc" }] },
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  return claim ? toClaimView(claim) : null;
}

export function adjudicateClaim(_claimId: string): Promise<ClaimView> {
  throw new Error("adjudicateClaim() not implemented");
}
