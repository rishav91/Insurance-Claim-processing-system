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

const notImplemented = (name: string): never => {
  throw new Error(`repository ${name}() not implemented`);
};

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

export function createMember(_data: { name: string; dateOfBirth: string }): Promise<Member> {
  return notImplemented("createMember");
}

export function createProvider(_data: { name: string }): Promise<Provider> {
  return notImplemented("createProvider");
}

export function createPlan(_data: PlanInput): Promise<PlanWithRules> {
  return notImplemented("createPlan");
}

export function getPlanWithRules(_planId: string): Promise<PlanWithRules | null> {
  return notImplemented("getPlanWithRules");
}

export function createPolicy(_data: {
  memberId: string;
  planId: string;
  effectiveFrom: string;
  effectiveTo: string;
}): Promise<Policy> {
  return notImplemented("createPolicy");
}

export function getPoliciesForMember(_memberId: string): Promise<Policy[]> {
  return notImplemented("getPoliciesForMember");
}

// ── Claims & lines ─────────────────────────────────────────────────────────

export interface LinePersistInput {
  serviceType: string;
  serviceDate: string;
  billedAmountCents: number;
  diagnosisCode?: string;
}

export function createClaim(_data: {
  memberId: string;
  providerId: string;
  lines: LinePersistInput[];
}): Promise<ClaimWithLines> {
  return notImplemented("createClaim");
}

// ── Accumulator ledger ─────────────────────────────────────────────────────

export interface AccumulatorSums {
  deductibleMetCents: number;
  benefitUsedByServiceType: Record<string, number>;
}

export function writeAccumulatorEntry(_data: {
  lineItemId: string;
  memberId: string;
  planYear: number;
  serviceType: string;
  deductibleDeltaCents: number;
  benefitDeltaCents: number;
}): Promise<AccumulatorEntry> {
  return notImplemented("writeAccumulatorEntry");
}

export function voidAccumulatorEntryForLine(_lineItemId: string): Promise<void> {
  return notImplemented("voidAccumulatorEntryForLine");
}

/** Usage = SUM of active (non-voided) entries for (member, planYear). */
export function loadAccumulators(
  _memberId: string,
  _planYear: number,
): Promise<AccumulatorSums> {
  return notImplemented("loadAccumulators");
}

export { prisma };
