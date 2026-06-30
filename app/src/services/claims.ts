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
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";

/** A valid ISO calendar date — keeps planYearOf / eligibility on one clean clock. */
function isValidServiceDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return false;
  // Reject calendar-impossible dates (e.g. 2026-02-30): `Date` silently rolls them
  // forward, so require the parsed value to round-trip back to the same string.
  return d.toISOString().slice(0, 10) === s;
}

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
  const badDates = input.lines.filter((l) => !isValidServiceDate(l.serviceDate));
  if (badDates.length > 0) {
    throw new ValidationError("line items have invalid serviceDate(s)", badDates.map(
      (l) => ({ path: "serviceDate", issue: `not an ISO date: ${l.serviceDate}` }),
    ));
  }

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

/** Load a member's enrollments with their plan + coverage rules (reference data). */
function loadMemberPolicies(memberId: string, db: DbClient = prisma) {
  return db.policy.findMany({
    where: { memberId },
    include: { plan: { include: { coverageRules: true } } },
  });
}

type MemberPolicy = Awaited<ReturnType<typeof loadMemberPolicies>>[number];

interface ResolvedCoverage {
  rule: PrismaCoverageRule | undefined;
  coverageActive: boolean;
  deductibleAnnualCents: number;
}

/**
 * Resolve coverage for one line by its OWN service date (domain-model.md §2): the
 * policy whose effective window contains the date governs it — coverage is derived
 * from the date of service, not asserted by the submitter. The non-overlap invariant
 * (createPolicy) guarantees at most one match; >1 is a loud invariant violation.
 *
 * If no policy is active on the date, the line is ineligible — but it's still
 * classified by the member's most recent enrollment so a *known* service denies as
 * COVERAGE_INACTIVE (gate 3) rather than INVALID_LINE (gate 1); pricing is moot since
 * eligibility short-circuits before the money steps.
 */
function resolveLineCoverage(
  policies: MemberPolicy[],
  serviceDate: string,
  serviceType: string,
): ResolvedCoverage {
  const active = policies.filter(
    (p) => p.effectiveFrom <= serviceDate && serviceDate <= p.effectiveTo,
  );
  if (active.length > 1) {
    throw new Error(
      `coverage invariant violated: ${active.length} policies active on ${serviceDate}`,
    );
  }
  const policy = active[0];
  if (policy) {
    return {
      rule: policy.plan.coverageRules.find((r) => r.serviceType === serviceType),
      coverageActive: true,
      deductibleAnnualCents: policy.plan.deductibleAnnualCents,
    };
  }
  const recentFirst = [...policies].sort((a, b) =>
    b.effectiveTo.localeCompare(a.effectiveTo),
  );
  const rule = recentFirst
    .map((p) => p.plan.coverageRules.find((r) => r.serviceType === serviceType))
    .find((r) => r !== undefined);
  return { rule, coverageActive: false, deductibleAnnualCents: 0 };
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
  if (!claim) throw new NotFoundError(`claim ${claimId} not found`);

  // Two-step flow: a claim is adjudicated once. Re-adjudication is a 409 — the
  // dispute/review path (§6) handles changing a finalized line, not this endpoint.
  if (!claim.lineItems.every((l) => l.status === "submitted")) {
    throw new ConflictError(`claim ${claimId} has already been adjudicated`);
  }

  // Reference data (immutable): the member's enrollments → plans → coverage rules.
  // Each line resolves its OWN policy by service date (per-line, not one per claim).
  const policies = await loadMemberPolicies(claim.memberId);
  if (policies.length === 0) {
    throw new NotFoundError(`no policy found for member ${claim.memberId}`);
  }

  await prisma.$transaction(
    async (tx) => {
      // Serialization point: take the write lock on the member row up front.
      await tx.member.update({
        where: { id: claim.memberId },
        data: { version: { increment: 1 } },
      });

      // Gather per-line facts — coverage resolved per line by its service date.
      const engineLines: ClaimLineForAdjudication[] = [];
      for (const l of claim.lineItems) {
        const cov = resolveLineCoverage(policies, l.serviceDate, l.serviceType);
        engineLines.push({
          id: l.id,
          line: {
            serviceType: l.serviceType,
            serviceDate: l.serviceDate,
            billedAmountCents: l.billedAmountCents,
          },
          ...(cov.rule && { rule: toEngineRule(cov.rule) }),
          coverageActive: cov.coverageActive,
          deductibleAnnualCents: cov.deductibleAnnualCents,
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
      // Deductible is per-line now (each line may sit under a different plan).
      const result = adjudicateClaimEngine({
        lines: engineLines,
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

/** Line states whose payable amount is disbursed on payment. */
const PAYABLE_LINE: ReadonlySet<string> = new Set(["approved", "partially_approved"]);

/**
 * Finalize an `approved`/`partially_approved` claim: move its non-denied lines to
 * `paid`, record `paidAmountCents` (Σ payable) + `paidAt`, append a PAID event.
 * `paid` is terminal — paid lines are no longer disputable (§4).
 */
export async function payClaim(claimId: string): Promise<ClaimView> {
  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    include: { lineItems: true },
  });
  if (!claim) throw new NotFoundError(`claim ${claimId} not found`);

  // Terminal guard: a claim with any paid line is already disbursed (§4).
  if (claim.lineItems.some((l) => l.status === "paid")) {
    throw new ConflictError(`claim ${claimId} is already paid`);
  }

  const status = deriveClaimStatus(claim.lineItems.map((l) => l.status as LineStatus));
  if (status !== "approved" && status !== "partially_approved") {
    throw new ConflictError(
      `claim ${claimId} is not in a payable state (status: ${status})`,
    );
  }

  const payLines = claim.lineItems.filter((l) => PAYABLE_LINE.has(l.status));
  const paidAmountCents = payLines.reduce((sum, l) => sum + (l.payableCents ?? 0), 0);

  await prisma.$transaction(async (tx) => {
    for (const l of payLines) {
      await tx.lineItem.update({ where: { id: l.id }, data: { status: "paid" } });
    }
    await tx.claim.update({
      where: { id: claimId },
      data: { paidAmountCents, paidAt: new Date() },
    });
    await tx.event.create({
      data: { claimId, type: "PAID", toState: "paid", actor: "system" },
    });
  });

  return (await getClaim(claimId))!;
}

export async function listClaims(memberId: string): Promise<ClaimSummary[]> {
  const claims = await prisma.claim.findMany({
    where: { memberId },
    include: { lineItems: true },
    orderBy: { submittedAt: "asc" },
  });
  return claims.map((c) => ({
    id: c.id,
    status: deriveClaimStatus(c.lineItems.map((l) => l.status as LineStatus)),
    submittedAt: c.submittedAt,
    lineCount: c.lineItems.length,
    totalPayableCents: c.lineItems.reduce((sum, l) => sum + (l.payableCents ?? 0), 0),
  }));
}

function toDisputeView(d: {
  id: string;
  lineItemId: string;
  status: string;
  reason: string;
  resolution: string | null;
  overrides: string | null;
  note: string | null;
}): DisputeView {
  return {
    id: d.id,
    lineItemId: d.lineItemId,
    status: d.status,
    reason: d.reason,
    resolution: d.resolution,
    overrides: d.overrides ? (JSON.parse(d.overrides) as Override[]) : null,
    note: d.note,
  };
}

export async function getDispute(disputeId: string): Promise<DisputeView | null> {
  const d = await prisma.dispute.findUnique({ where: { id: disputeId } });
  return d ? toDisputeView(d) : null;
}

export async function getMemberAccumulators(
  memberId: string,
  planYear: number,
): Promise<MemberAccumulatorsView> {
  const policies = await loadMemberPolicies(memberId);
  if (policies.length === 0) throw new NotFoundError(`no policy found for member ${memberId}`);

  // The displayed annual figures come from the plan enrolled during this year (the
  // one starting latest within it); usage itself is summed from the ledger below.
  const yearStart = `${planYear}-01-01`;
  const yearEnd = `${planYear}-12-31`;
  const inYear = policies
    .filter((p) => p.effectiveFrom <= yearEnd && yearStart <= p.effectiveTo)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const fallback = [...policies].sort((a, b) => b.effectiveTo.localeCompare(a.effectiveTo));
  const plan = (inYear[0] ?? fallback[0]!).plan;

  const acc = await loadAccumulators(memberId, planYear);
  const limitsByServiceType: Record<string, number> = {};
  for (const r of plan.coverageRules) {
    if (r.annualLimitCents !== null) limitsByServiceType[r.serviceType] = r.annualLimitCents;
  }

  return {
    memberId,
    planYear,
    deductibleAnnualCents: plan.deductibleAnnualCents,
    deductibleMetCents: acc.deductibleMetCents,
    benefitUsedByServiceType: acc.benefitUsedByServiceType,
    limitsByServiceType,
  };
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
  coverageActive: boolean;
  deductibleAnnualCents: number;
  rule: PrismaCoverageRule | undefined;
}

/**
 * Load a line plus the reference data the engine needs to re-adjudicate it, with
 * coverage resolved by the line's OWN service date (same per-line rule as
 * adjudicateClaim). Pass the transaction client so the line's mutable status is read
 * UNDER the member lock (the resolve/review guards depend on this).
 */
async function loadLineContext(
  lineItemId: string,
  db: DbClient = prisma,
): Promise<LineContext> {
  const lineItem = await db.lineItem.findUnique({
    where: { id: lineItemId },
    include: { claim: true },
  });
  if (!lineItem) throw new NotFoundError(`line ${lineItemId} not found`);

  const policies = await loadMemberPolicies(lineItem.claim.memberId, db);
  if (policies.length === 0) {
    throw new NotFoundError(`no policy found for member ${lineItem.claim.memberId}`);
  }
  const cov = resolveLineCoverage(policies, lineItem.serviceDate, lineItem.serviceType);

  return {
    lineItem,
    claim: lineItem.claim,
    coverageActive: cov.coverageActive,
    deductibleAnnualCents: cov.deductibleAnnualCents,
    rule: cov.rule,
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
  const { lineItem, claim, rule } = ctx;

  await voidAccumulatorEntryForLine(lineItem.id, tx);

  const year = planYearOf(lineItem.serviceDate);
  const acc = await loadAccumulators(claim.memberId, year, tx);

  // Re-derive the SAME facts the engine saw at adjudication, so an overturn that
  // supplies no override doesn't silently bypass a gate. coverageActive and the
  // per-line deductible come from the line's resolved policy (ctx); duplicate is
  // recomputed here — it is only bypassed via ALLOW_DUPLICATE.
  const adjCtx: AdjudicationContext = {
    ...(rule && { rule: toEngineRule(rule) }),
    coverageActive: ctx.coverageActive,
    isDuplicate: await hasDuplicate(tx, {
      memberId: claim.memberId,
      providerId: claim.providerId,
      serviceType: lineItem.serviceType,
      serviceDate: lineItem.serviceDate,
      excludeClaimId: claim.id,
    }),
    accumulator: {
      deductibleAnnualCents: ctx.deductibleAnnualCents,
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

  return r.outcome;
}

/**
 * A member contests a resolved (pre-payment) line → `disputed`, claim re-derives.
 * Returns the created dispute (api.md §6 returns the dispute, not the claim), so the
 * HTTP layer needs no second read — the row is already in hand inside the transaction.
 */
export async function disputeLine(
  lineItemId: string,
  reason: string,
): Promise<DisputeView> {
  // Read-check-act inside one transaction (consistent with adjudication's locking
  // discipline), so a concurrent pay/resolve can't change the line between the
  // disputability check and the dispute write.
  const created = await prisma.$transaction(async (tx) => {
    const lineItem = await tx.lineItem.findUnique({ where: { id: lineItemId } });
    if (!lineItem) throw new NotFoundError(`line ${lineItemId} not found`);
    if (!DISPUTABLE.has(lineItem.status)) {
      throw new ConflictError(
        `line ${lineItemId} is not disputable (status: ${lineItem.status})`,
      );
    }
    // One dispute per line (decisions.md): re-appeals are out of scope. Pre-check so
    // a second dispute is a clean 409, not a raw unique-constraint violation (500).
    const existing = await tx.dispute.findUnique({ where: { lineItemId } });
    if (existing) {
      throw new ConflictError(
        `line ${lineItemId} already has a dispute (status: ${existing.status})`,
      );
    }

    const dispute = await tx.dispute.create({
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
    return dispute;
  });

  return toDisputeView(created);
}

/**
 * Reviewer resolves a dispute: `uphold` (no change) or `overturn` (+overrides).
 * Keyed on the dispute id the endpoint exposes (api.md §8) — no dispute→line
 * translation in the handler. The `open` guard is re-read UNDER the member lock so
 * two concurrent resolves can't both pass it (TOCTOU): the loser sees `resolved`.
 */
export async function resolveDispute(
  disputeId: string,
  resolution: DisputeResolution,
  opts: ResolutionOptions = {},
): Promise<ClaimView> {
  // Immutable traversal only, to find the member to lock. The mutable open-check is
  // deferred until inside the transaction, after the lock is held.
  const head = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: { lineItem: { include: { claim: true } } },
  });
  if (!head) throw new NotFoundError(`dispute ${disputeId} not found`);
  const memberId = head.lineItem.claim.memberId;

  const claimId = await prisma.$transaction(
    async (tx) => {
      // Same serialization point as adjudication: lock the member row first.
      await tx.member.update({
        where: { id: memberId },
        data: { version: { increment: 1 } },
      });

      // Re-read the dispute UNDER the lock — a concurrent resolve that won the lock
      // first has already flipped it to `resolved`, so this is the real guard.
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
      if (!dispute) throw new NotFoundError(`dispute ${disputeId} not found`);
      if (dispute.status !== "open") {
        throw new ConflictError(`dispute ${disputeId} is already resolved`);
      }
      const ctx = await loadLineContext(dispute.lineItemId, tx);

      let toState: string;
      if (resolution === "uphold") {
        // Trivial case: restore the pre-dispute outcome, no ledger change.
        toState = dispute.fromStatus;
        await tx.lineItem.update({
          where: { id: dispute.lineItemId },
          data: { status: dispute.fromStatus },
        });
      } else {
        toState = await rerunLineInTx(tx, ctx, opts.overrides);
      }

      await tx.dispute.update({
        where: { id: disputeId },
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
          lineItemId: dispute.lineItemId,
          type: "RESOLVED",
          fromState: "disputed",
          toState,
          actor: "reviewer",
          ...(opts.note !== undefined && { note: opts.note }),
          ...(opts.overrides && { overridesApplied: JSON.stringify(opts.overrides) }),
        },
      });
      return ctx.claim.id;
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  return (await getClaim(claimId))!;
}

/** Reviewer resolves a pended (manual-review) line: `approve` (run engine) or `deny`. */
export async function reviewLine(
  lineItemId: string,
  action: ReviewAction,
  opts: ResolutionOptions = {},
): Promise<ClaimView> {
  // Immutable traversal only, to find the member to lock; the mutable pended-check
  // is re-read inside the transaction so two concurrent reviews can't both pass it.
  const head = await prisma.lineItem.findUnique({
    where: { id: lineItemId },
    include: { claim: true },
  });
  if (!head) throw new NotFoundError(`line ${lineItemId} not found`);
  const memberId = head.claim.memberId;

  const claimId = await prisma.$transaction(
    async (tx) => {
      await tx.member.update({
        where: { id: memberId },
        data: { version: { increment: 1 } },
      });

      const ctx = await loadLineContext(lineItemId, tx);
      if (ctx.lineItem.status !== "pended") {
        throw new ConflictError(
          `line ${lineItemId} is not pending review (status: ${ctx.lineItem.status})`,
        );
      }

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
      return ctx.claim.id;
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  return (await getClaim(claimId))!;
}
