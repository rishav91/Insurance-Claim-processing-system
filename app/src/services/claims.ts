/**
 * Orchestration service (roadmap Phase 3): wires the pure engine to the database.
 * This is where the "gather facts" work lives — rule matching, eligibility,
 * duplicate detection, ledger summing — all I/O the PHI-free engine must not do.
 *
 * The engine (`src/domain/`) stays pure; this layer loads inputs, calls it, and
 * persists results + ledger entries + events inside one serialized transaction.
 */
import type {
  Claim,
  CoverageRule as PrismaCoverageRule,
  Event,
  LineItem,
} from "@prisma/client";
import type {
  ClaimStatus,
  CoverageRule,
  LineStatus,
  Override,
  Reason,
} from "../domain/types.js";
import { deriveClaimStatus } from "../domain/claim-status.js";
import {
  adjudicateClaim as adjudicateClaimEngine,
  planYearOf,
  type ClaimLineForAdjudication,
} from "../domain/adjudicate-claim.js";
import { prisma } from "../db/client.js";
import {
  loadAccumulators,
  writeAccumulatorEntry,
  type DbClient,
} from "../db/repositories.js";

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

/** Prisma CoverageRule (nullable columns) → engine CoverageRule (omit absent). */
function toEngineRule(r: PrismaCoverageRule): CoverageRule {
  return {
    serviceType: r.serviceType,
    excluded: r.excluded,
    requiresManualReview: r.requiresManualReview,
    ...(r.allowedAmountCents !== null && { allowedAmountCents: r.allowedAmountCents }),
    ...(r.copayCents !== null && { copayCents: r.copayCents }),
    ...(r.coinsuranceRate !== null && { coinsuranceRate: r.coinsuranceRate }),
    ...(r.annualLimitCents !== null && { annualLimitCents: r.annualLimitCents }),
  };
}

/** Policy effective window contains the service date (lexicographic on ISO dates). */
function coverageActiveOn(serviceDate: string, from: string, to: string): boolean {
  return from <= serviceDate && serviceDate <= to;
}

/**
 * A prior NON-DENIED, already-adjudicated line for the same
 * (member, serviceType, serviceDate, provider) on a DIFFERENT claim
 * (decisions.md §4 — the realistic resubmission case).
 */
async function hasDuplicate(
  tx: DbClient,
  args: {
    memberId: string;
    providerId: string;
    serviceType: string;
    serviceDate: string;
    excludeClaimId: string;
  },
): Promise<boolean> {
  const found = await tx.lineItem.findFirst({
    where: {
      serviceType: args.serviceType,
      serviceDate: args.serviceDate,
      status: { notIn: ["denied", "submitted"] },
      claim: {
        memberId: args.memberId,
        providerId: args.providerId,
        id: { not: args.excludeClaimId },
      },
    },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Two-step flow, step 2 (domain-model.md §5). Gather facts (rule match,
 * eligibility, duplicate, ledger sum), call the pure engine, and persist line
 * results + ledger entries + events — all inside ONE serialized transaction that
 * locks the member row before summing the ledger (§ concurrency invariant).
 */
export async function adjudicateClaim(claimId: string): Promise<ClaimView> {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    include: { lineItems: true },
  });
  if (!claim) throw new Error(`claim ${claimId} not found`);

  // Reference data (immutable): the member's policy → plan → coverage rules.
  const policy = await prisma.policy.findFirst({
    where: { memberId: claim.memberId },
    include: { plan: { include: { coverageRules: true } } },
  });
  if (!policy) throw new Error(`no policy found for member ${claim.memberId}`);
  const plan = policy.plan;
  const ruleByService = new Map(plan.coverageRules.map((r) => [r.serviceType, r]));

  await prisma.$transaction(
    async (tx) => {
      // Serialization point: take the write lock on the member row up front.
      await tx.member.update({
        where: { id: claim.memberId },
        data: { version: { increment: 1 } },
      });

      // Gather per-line facts.
      const engineLines: ClaimLineForAdjudication[] = [];
      for (const l of claim.lineItems) {
        const rule = ruleByService.get(l.serviceType);
        engineLines.push({
          id: l.id,
          line: {
            serviceType: l.serviceType,
            serviceDate: l.serviceDate,
            billedAmountCents: l.billedAmountCents,
          },
          ...(rule && { rule: toEngineRule(rule) }),
          coverageActive: coverageActiveOn(
            l.serviceDate,
            policy.effectiveFrom,
            policy.effectiveTo,
          ),
          isDuplicate: await hasDuplicate(tx, {
            memberId: claim.memberId,
            providerId: claim.providerId,
            serviceType: l.serviceType,
            serviceDate: l.serviceDate,
            excludeClaimId: claim.id,
          }),
        });
      }

      // Sum the ledger for each plan year the claim touches (serviceDate-keyed).
      const years = [...new Set(claim.lineItems.map((l) => planYearOf(l.serviceDate)))];
      const initialDeductibleMetByYear: Record<number, number> = {};
      const initialBenefitUsedByYearService: Record<string, number> = {};
      for (const year of years) {
        const acc = await loadAccumulators(claim.memberId, year, tx);
        initialDeductibleMetByYear[year] = acc.deductibleMetCents;
        for (const [svc, used] of Object.entries(acc.benefitUsedByServiceType)) {
          initialBenefitUsedByYearService[`${year}:${svc}`] = used;
        }
      }

      // Call the pure engine (folds the accumulator across the claim's lines).
      const result = adjudicateClaimEngine({
        lines: engineLines,
        deductibleAnnualCents: plan.deductibleAnnualCents,
        initialDeductibleMetByYear,
        initialBenefitUsedByYearService,
      });

      // Persist: line breakdown + ledger entry per finalized line + events.
      const lineById = new Map<string, LineItem>(claim.lineItems.map((l) => [l.id, l]));
      for (const { id, result: r } of result.lines) {
        await tx.lineItem.update({
          where: { id },
          data: {
            status: r.outcome,
            allowedCents: r.allowedCents,
            payableCents: r.payableCents,
            memberResponsibilityCents: r.memberResponsibilityCents,
            deductibleAppliedCents: r.deductibleAppliedCents,
            memberCostShareCents: r.memberCostShareCents,
            reasons: JSON.stringify(r.reasons),
          },
        });

        const delta = r.accumulatorDelta;
        if (delta.deductibleMetCents > 0 || delta.benefitUsedCents > 0) {
          const src = lineById.get(id)!;
          await writeAccumulatorEntry(
            {
              lineItemId: id,
              memberId: claim.memberId,
              planYear: planYearOf(src.serviceDate),
              serviceType: src.serviceType,
              deductibleDeltaCents: delta.deductibleMetCents,
              benefitDeltaCents: delta.benefitUsedCents,
            },
            tx,
          );
        }

        await tx.event.create({
          data: {
            claimId: claim.id,
            lineItemId: id,
            type: r.outcome === "pended" ? "PENDED" : "ADJUDICATED",
            fromState: "submitted",
            toState: r.outcome,
            actor: "system",
          },
        });
      }
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  return (await getClaim(claimId))!;
}

// ── Phase 4: disputes & manual-review resolution (domain-model.md §6) ─────────

export type ReviewAction = "approve" | "deny";
export type DisputeResolution = "uphold" | "overturn";

export interface ResolutionOptions {
  overrides?: Override[];
  note?: string;
}

/** A member contests a resolved (pre-payment) line → `disputed`, claim re-derives. */
export function disputeLine(_lineItemId: string, _reason: string): Promise<ClaimView> {
  throw new Error("disputeLine() not implemented");
}

/** Reviewer resolves a dispute: `uphold` (no change) or `overturn` (+overrides). */
export function resolveDispute(
  _lineItemId: string,
  _resolution: DisputeResolution,
  _opts?: ResolutionOptions,
): Promise<ClaimView> {
  throw new Error("resolveDispute() not implemented");
}

/** Reviewer resolves a pended (manual-review) line: `approve` (run engine) or `deny`. */
export function reviewLine(
  _lineItemId: string,
  _action: ReviewAction,
  _opts?: ResolutionOptions,
): Promise<ClaimView> {
  throw new Error("reviewLine() not implemented");
}
