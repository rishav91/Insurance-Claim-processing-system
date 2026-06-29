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
import { adjudicateLine, type AdjudicationContext } from "../domain/adjudicate.js";
import { prisma } from "../db/client.js";
import {
  loadAccumulators,
  voidAccumulatorEntryForLine,
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

/** Summary row for the member's claim list (api.md endpoint 4). */
export interface ClaimSummary {
  id: string;
  status: ClaimStatus;
  submittedAt: Date;
  lineCount: number;
  totalPayableCents: number;
}

/** Dispute read model (api.md endpoint 7). */
export interface DisputeView {
  id: string;
  lineItemId: string;
  status: string;
  reason: string;
  resolution: string | null;
  overrides: Override[] | null;
  note: string | null;
}

/** Live accumulator snapshot for a member + plan year (api.md endpoint 10). */
export interface MemberAccumulatorsView {
  memberId: string;
  planYear: number;
  deductibleAnnualCents: number;
  deductibleMetCents: number;
  benefitUsedByServiceType: Record<string, number>;
  limitsByServiceType: Record<string, number>;
}

export function payClaim(_claimId: string): Promise<ClaimView> {
  throw new Error("payClaim() not implemented");
}

export function listClaims(_memberId: string): Promise<ClaimSummary[]> {
  throw new Error("listClaims() not implemented");
}

export function getDispute(_disputeId: string): Promise<DisputeView | null> {
  throw new Error("getDispute() not implemented");
}

export function getMemberAccumulators(
  _memberId: string,
  _planYear: number,
): Promise<MemberAccumulatorsView> {
  throw new Error("getMemberAccumulators() not implemented");
}

/** Decided, pre-payment line states that may be disputed (§4). */
const DISPUTABLE: ReadonlySet<string> = new Set([
  "approved",
  "partially_approved",
  "denied",
]);

interface LineContext {
  lineItem: LineItem;
  claim: Claim;
  policy: { effectiveFrom: string; effectiveTo: string };
  plan: { deductibleAnnualCents: number };
  rule: PrismaCoverageRule | undefined;
}

/** Load a line plus the reference data the engine needs to re-adjudicate it. */
async function loadLineContext(lineItemId: string): Promise<LineContext> {
  const lineItem = await prisma.lineItem.findUnique({
    where: { id: lineItemId },
    include: { claim: true },
  });
  if (!lineItem) throw new Error(`line ${lineItemId} not found`);

  const policy = await prisma.policy.findFirst({
    where: { memberId: lineItem.claim.memberId },
    include: { plan: { include: { coverageRules: true } } },
  });
  if (!policy) throw new Error(`no policy found for member ${lineItem.claim.memberId}`);

  return {
    lineItem,
    claim: lineItem.claim,
    policy,
    plan: policy.plan,
    rule: policy.plan.coverageRules.find((r) => r.serviceType === lineItem.serviceType),
  };
}

/**
 * The single reconciliation path (§6): void the line's prior active ledger entry,
 * re-run the pure engine against the CURRENT ledger (skipping manual review, with
 * any overrides), persist the new breakdown, and write a fresh entry for the delta.
 * Returns the new outcome. Must run inside the caller's locked transaction.
 */
async function rerunLineInTx(
  tx: DbClient,
  ctx: LineContext,
  overrides?: Override[],
): Promise<LineStatus> {
  const { lineItem, claim, policy, plan, rule } = ctx;

  await voidAccumulatorEntryForLine(lineItem.id, tx);

  const year = planYearOf(lineItem.serviceDate);
  const acc = await loadAccumulators(claim.memberId, year, tx);

  const adjCtx: AdjudicationContext = {
    ...(rule && { rule: toEngineRule(rule) }),
    coverageActive: coverageActiveOn(
      lineItem.serviceDate,
      policy.effectiveFrom,
      policy.effectiveTo,
    ),
    isDuplicate: false,
    accumulator: {
      deductibleAnnualCents: plan.deductibleAnnualCents,
      deductibleMetCents: acc.deductibleMetCents,
      benefitUsedCents: acc.benefitUsedByServiceType[lineItem.serviceType] ?? 0,
    },
    skipManualReview: true,
    ...(overrides && overrides.length > 0 && { overrides }),
  };

  const r = adjudicateLine(
    {
      serviceType: lineItem.serviceType,
      serviceDate: lineItem.serviceDate,
      billedAmountCents: lineItem.billedAmountCents,
    },
    adjCtx,
  );

  await tx.lineItem.update({
    where: { id: lineItem.id },
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

  const d = r.accumulatorDelta;
  if (d.deductibleMetCents > 0 || d.benefitUsedCents > 0) {
    await writeAccumulatorEntry(
      {
        lineItemId: lineItem.id,
        memberId: claim.memberId,
        planYear: year,
        serviceType: lineItem.serviceType,
        deductibleDeltaCents: d.deductibleMetCents,
        benefitDeltaCents: d.benefitUsedCents,
      },
      tx,
    );
  }

  return r.outcome as LineStatus;
}

/** A member contests a resolved (pre-payment) line → `disputed`, claim re-derives. */
export async function disputeLine(
  lineItemId: string,
  reason: string,
): Promise<ClaimView> {
  const lineItem = await prisma.lineItem.findUnique({ where: { id: lineItemId } });
  if (!lineItem) throw new Error(`line ${lineItemId} not found`);
  if (!DISPUTABLE.has(lineItem.status)) {
    throw new Error(
      `line ${lineItemId} is not disputable (status: ${lineItem.status})`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.dispute.create({
      data: { lineItemId, reason, fromStatus: lineItem.status, status: "open" },
    });
    await tx.lineItem.update({
      where: { id: lineItemId },
      data: { status: "disputed" },
    });
    await tx.event.create({
      data: {
        claimId: lineItem.claimId,
        lineItemId,
        type: "DISPUTED",
        fromState: lineItem.status,
        toState: "disputed",
        actor: "member",
        note: reason,
      },
    });
  });

  return (await getClaim(lineItem.claimId))!;
}

/** Reviewer resolves a dispute: `uphold` (no change) or `overturn` (+overrides). */
export async function resolveDispute(
  lineItemId: string,
  resolution: DisputeResolution,
  opts: ResolutionOptions = {},
): Promise<ClaimView> {
  const ctx = await loadLineContext(lineItemId);
  const dispute = await prisma.dispute.findUnique({ where: { lineItemId } });
  if (!dispute || dispute.status !== "open") {
    throw new Error(`no open dispute for line ${lineItemId}`);
  }

  await prisma.$transaction(
    async (tx) => {
      // Same serialization point as adjudication: lock the member row first.
      await tx.member.update({
        where: { id: ctx.claim.memberId },
        data: { version: { increment: 1 } },
      });

      let toState: string;
      if (resolution === "uphold") {
        // Trivial case: restore the pre-dispute outcome, no ledger change.
        toState = dispute.fromStatus;
        await tx.lineItem.update({
          where: { id: lineItemId },
          data: { status: dispute.fromStatus },
        });
      } else {
        toState = await rerunLineInTx(tx, ctx, opts.overrides);
      }

      await tx.dispute.update({
        where: { lineItemId },
        data: {
          status: "resolved",
          resolution,
          ...(opts.overrides && { overrides: JSON.stringify(opts.overrides) }),
          ...(opts.note !== undefined && { note: opts.note }),
        },
      });
      await tx.event.create({
        data: {
          claimId: ctx.claim.id,
          lineItemId,
          type: "RESOLVED",
          fromState: "disputed",
          toState,
          actor: "reviewer",
          ...(opts.note !== undefined && { note: opts.note }),
          ...(opts.overrides && { overridesApplied: JSON.stringify(opts.overrides) }),
        },
      });
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  return (await getClaim(ctx.claim.id))!;
}

/** Reviewer resolves a pended (manual-review) line: `approve` (run engine) or `deny`. */
export async function reviewLine(
  lineItemId: string,
  action: ReviewAction,
  opts: ResolutionOptions = {},
): Promise<ClaimView> {
  const ctx = await loadLineContext(lineItemId);
  if (ctx.lineItem.status !== "pended") {
    throw new Error(
      `line ${lineItemId} is not pending review (status: ${ctx.lineItem.status})`,
    );
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.member.update({
        where: { id: ctx.claim.memberId },
        data: { version: { increment: 1 } },
      });

      let toState: LineStatus;
      if (action === "approve") {
        toState = await rerunLineInTx(tx, ctx, opts.overrides);
      } else {
        // Deny: finalize with no money or ledger effect (a pended line had none).
        toState = "denied";
        const reason: Reason = {
          code: "REVIEW_DENIED",
          message: opts.note ?? "Denied on manual review",
        };
        await tx.lineItem.update({
          where: { id: lineItemId },
          data: {
            status: "denied",
            allowedCents: 0,
            payableCents: 0,
            memberResponsibilityCents: 0,
            deductibleAppliedCents: 0,
            memberCostShareCents: 0,
            reasons: JSON.stringify([reason]),
          },
        });
      }

      await tx.event.create({
        data: {
          claimId: ctx.claim.id,
          lineItemId,
          type: "RESOLVED",
          fromState: "pended",
          toState,
          actor: "reviewer",
          ...(opts.note !== undefined && { note: opts.note }),
          ...(opts.overrides && { overridesApplied: JSON.stringify(opts.overrides) }),
        },
      });
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  return (await getClaim(ctx.claim.id))!;
}
