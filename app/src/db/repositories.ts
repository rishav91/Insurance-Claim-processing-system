/**
 * Thin, typed persistence functions over the Prisma client (roadmap Phase 2).
 * No generic DAL abstraction — just small functions the orchestration layer calls.
 * The pure engine never imports this file; I/O stays at the edges.
 */
import type {
  AccumulatorEntry,
  Member,
  Policy,
  Prisma,
  Provider,
} from "@prisma/client";
import { prisma } from "./client.js";

export type PlanWithRules = Prisma.PlanGetPayload<{ include: { coverageRules: true } }>;
export type ClaimWithLines = Prisma.ClaimGetPayload<{ include: { lineItems: true } }>;

/** Either the base client or an interactive-transaction client. */
export type DbClient = Prisma.TransactionClient;

// ── Reference data (seeded, not API-managed) ───────────────────────────────

export interface RuleInput {
  serviceType: string;
  excluded?: boolean;
  allowedAmountCents?: number;
  copayCents?: number;
  coinsuranceRate?: number;
  annualLimitCents?: number;
  requiresManualReview?: boolean;
}

export interface PlanInput {
  name: string;
  planYear: number;
  deductibleAnnualCents: number;
  rules: RuleInput[];
}

/** Map a RuleInput to a Prisma create payload, omitting absent optionals
 *  (exactOptionalPropertyTypes — never assign `undefined`). */
function ruleCreate(r: RuleInput): Prisma.CoverageRuleCreateWithoutPlanInput {
  return {
    serviceType: r.serviceType,
    ...(r.excluded !== undefined && { excluded: r.excluded }),
    ...(r.allowedAmountCents !== undefined && { allowedAmountCents: r.allowedAmountCents }),
    ...(r.copayCents !== undefined && { copayCents: r.copayCents }),
    ...(r.coinsuranceRate !== undefined && { coinsuranceRate: r.coinsuranceRate }),
    ...(r.annualLimitCents !== undefined && { annualLimitCents: r.annualLimitCents }),
    ...(r.requiresManualReview !== undefined && {
      requiresManualReview: r.requiresManualReview,
    }),
  };
}

export function createMember(data: { name: string; dateOfBirth: string }): Promise<Member> {
  return prisma.member.create({ data });
}

export function createProvider(data: { name: string }): Promise<Provider> {
  return prisma.provider.create({ data });
}

export function createPlan(data: PlanInput): Promise<PlanWithRules> {
  return prisma.plan.create({
    data: {
      name: data.name,
      planYear: data.planYear,
      deductibleAnnualCents: data.deductibleAnnualCents,
      coverageRules: { create: data.rules.map(ruleCreate) },
    },
    include: { coverageRules: true },
  });
}

export function getPlanWithRules(planId: string): Promise<PlanWithRules | null> {
  return prisma.plan.findUnique({
    where: { id: planId },
    include: { coverageRules: true },
  });
}

export function createPolicy(data: {
  memberId: string;
  planId: string;
  effectiveFrom: string;
  effectiveTo: string;
}): Promise<Policy> {
  return prisma.policy.create({ data });
}

export function getPoliciesForMember(memberId: string): Promise<Policy[]> {
  return prisma.policy.findMany({ where: { memberId } });
}

// ── Claims & lines ─────────────────────────────────────────────────────────

export interface LinePersistInput {
  serviceType: string;
  serviceDate: string;
  billedAmountCents: number;
  diagnosisCode?: string;
}

export function createClaim(data: {
  memberId: string;
  providerId: string;
  lines: LinePersistInput[];
}): Promise<ClaimWithLines> {
  return prisma.claim.create({
    data: {
      memberId: data.memberId,
      providerId: data.providerId,
      lineItems: {
        create: data.lines.map((l) => ({
          serviceType: l.serviceType,
          serviceDate: l.serviceDate,
          billedAmountCents: l.billedAmountCents,
          ...(l.diagnosisCode !== undefined && { diagnosisCode: l.diagnosisCode }),
        })),
      },
    },
    include: { lineItems: true },
  });
}

// ── Accumulator ledger ─────────────────────────────────────────────────────

export interface AccumulatorSums {
  deductibleMetCents: number;
  benefitUsedByServiceType: Record<string, number>;
}

export function writeAccumulatorEntry(
  data: {
    lineItemId: string;
    memberId: string;
    planYear: number;
    serviceType: string;
    deductibleDeltaCents: number;
    benefitDeltaCents: number;
  },
  db: DbClient = prisma,
): Promise<AccumulatorEntry> {
  return db.accumulatorEntry.create({ data });
}

/** Void the active ledger entry for a line (dispute/resolution reversal, §6). */
export async function voidAccumulatorEntryForLine(
  lineItemId: string,
  db: DbClient = prisma,
): Promise<void> {
  await db.accumulatorEntry.updateMany({
    where: { lineItemId, voided: false },
    data: { voided: true },
  });
}

/**
 * Usage as a SUM on read: aggregate active (non-voided) entries for
 * (member, planYear). The deductible is a single annual figure (sum across all
 * service types); the benefit limit is per service type.
 */
export async function loadAccumulators(
  memberId: string,
  planYear: number,
  db: DbClient = prisma,
): Promise<AccumulatorSums> {
  const grouped = await db.accumulatorEntry.groupBy({
    by: ["serviceType"],
    where: { memberId, planYear, voided: false },
    _sum: { deductibleDeltaCents: true, benefitDeltaCents: true },
  });

  let deductibleMetCents = 0;
  const benefitUsedByServiceType: Record<string, number> = {};
  for (const g of grouped) {
    deductibleMetCents += g._sum.deductibleDeltaCents ?? 0;
    benefitUsedByServiceType[g.serviceType] = g._sum.benefitDeltaCents ?? 0;
  }
  return { deductibleMetCents, benefitUsedByServiceType };
}

export { prisma };
