import type { CoverageRule, LineInput, Override, ClaimStatus, LineStatus } from "./types.js";
import { adjudicateLine, type AdjudicationResult } from "./adjudicate.js";
import { deriveClaimStatus } from "./claim-status.js";

/** One line plus the facts the orchestrator gathered for it. */
export interface ClaimLineForAdjudication {
  id: string;
  line: LineInput;
  rule?: CoverageRule | undefined;
  coverageActive: boolean;
  isDuplicate: boolean;
  overrides?: Override[];
}

export interface ClaimAdjudicationInput {
  lines: ClaimLineForAdjudication[];
  /** Policy-level annual deductible (same figure resets each plan year). */
  deductibleAnnualCents: number;
  /** Deductible already met per plan year, from the DB. */
  initialDeductibleMetByYear: Record<number, number>;
  /** Insurer-paid so far, keyed `${planYear}:${serviceType}`, from the DB. */
  initialBenefitUsedByYearService: Record<string, number>;
}

export interface ClaimAdjudicationResult {
  /** Per-line results, in the original input order. */
  lines: { id: string; result: AdjudicationResult }[];
  claimStatus: ClaimStatus;
  finalDeductibleMetByYear: Record<number, number>;
  finalBenefitUsedByYearService: Record<string, number>;
}

/** Plan year is governed by the date of service (domain-model.md §2). */
export function planYearOf(serviceDate: string): number {
  return new Date(serviceDate).getUTCFullYear();
}

const benefitKey = (year: number, serviceType: string): string => `${year}:${serviceType}`;

/**
 * Adjudicate a whole claim as one transaction, folding the accumulator through
 * its lines so each line sees the effect of the prior ones (domain-model.md §5).
 * Lines are processed in deterministic (serviceDate, id) order; each line reads
 * and writes the accumulator for ITS OWN service-date plan year.
 */
export function adjudicateClaim(input: ClaimAdjudicationInput): ClaimAdjudicationResult {
  const dedMet: Record<number, number> = { ...input.initialDeductibleMetByYear };
  const benUsed: Record<string, number> = { ...input.initialBenefitUsedByYearService };

  const ordered = [...input.lines].sort(
    (a, b) =>
      a.line.serviceDate.localeCompare(b.line.serviceDate) || a.id.localeCompare(b.id),
  );

  const byId = new Map<string, AdjudicationResult>();

  for (const cl of ordered) {
    const year = planYearOf(cl.line.serviceDate);
    const bKey = benefitKey(year, cl.line.serviceType);

    const result = adjudicateLine(cl.line, {
      rule: cl.rule,
      coverageActive: cl.coverageActive,
      isDuplicate: cl.isDuplicate,
      accumulator: {
        deductibleAnnualCents: input.deductibleAnnualCents,
        deductibleMetCents: dedMet[year] ?? 0,
        benefitUsedCents: benUsed[bKey] ?? 0,
      },
      ...(cl.overrides && { overrides: cl.overrides }),
    });

    // Fold this line's delta forward so later lines in the same claim see it.
    dedMet[year] = (dedMet[year] ?? 0) + result.accumulatorDelta.deductibleMetCents;
    benUsed[bKey] = (benUsed[bKey] ?? 0) + result.accumulatorDelta.benefitUsedCents;

    byId.set(cl.id, result);
  }

  // Preserve original input order in the output.
  const lines = input.lines.map((cl) => ({ id: cl.id, result: byId.get(cl.id)! }));
  const claimStatus = deriveClaimStatus(lines.map((l) => l.result.outcome as LineStatus));

  return {
    lines,
    claimStatus,
    finalDeductibleMetByYear: dedMet,
    finalBenefitUsedByYearService: benUsed,
  };
}
