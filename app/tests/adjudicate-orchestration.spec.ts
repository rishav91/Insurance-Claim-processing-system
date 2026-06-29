import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import { seedScenario } from "./helpers/seed.js";
import { adjudicateClaim, submitClaim } from "../src/services/claims.js";
import { loadAccumulators } from "../src/db/repositories.js";

beforeEach(resetDb);

/**
 * Orchestration-level specs (roadmap Phase 3): the engine wired to the DB.
 * These exercise the cross-request behavior the pure engine can't: the ledger
 * persisted across claims, duplicate detection, eligibility windows, and the
 * serialization invariant.
 */

describe("adjudicateClaim — accumulators across claims", () => {
  it("depletes the annual deductible across two separate claims", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }], // 100% after deductible
      deductibleAnnualCents: 100_000,
    });

    const c1 = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 60_000 }],
    });
    await adjudicateClaim(c1.id);

    const c2 = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-04-01", billedAmountCents: 60_000 }],
    });
    const v2 = await adjudicateClaim(c2.id);

    // Claim 1 met $600 of the $1000 deductible; claim 2 sees the remaining $400.
    const l2 = v2.lineItems[0]!;
    expect(l2.deductibleAppliedCents).toBe(40_000);
    expect(l2.payableCents).toBe(20_000); // base 60k − 40k deductible, 0% coinsurance
    expect(l2.status).toBe("approved");

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.deductibleMetCents).toBe(100_000);
  });

  it("writes the benefit ledger so benefitUsed = Σ active entries", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
    });

    const c = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    const v = await adjudicateClaim(c.id);

    expect(v.lineItems[0]!.status).toBe("approved");
    expect(v.lineItems[0]!.payableCents).toBe(50_000);

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["PT"]).toBe(50_000);
  });
});

describe("adjudicateClaim — duplicate detection", () => {
  it("denies a same (service, date, provider) line on a second claim as DUPLICATE", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });

    const first = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    await adjudicateClaim(first.id);

    const second = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    const v = await adjudicateClaim(second.id);

    expect(v.lineItems[0]!.status).toBe("denied");
    expect(v.lineItems[0]!.reasons.map((r) => r.code)).toContain("DUPLICATE");
  });
});

describe("adjudicateClaim — eligibility & manual review (fact gathering)", () => {
  it("denies a line whose serviceDate falls outside the policy window as COVERAGE_INACTIVE", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-12-31",
    });

    const c = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    const v = await adjudicateClaim(c.id);

    expect(v.lineItems[0]!.status).toBe("denied");
    expect(v.lineItems[0]!.reasons.map((r) => r.code)).toContain("COVERAGE_INACTIVE");
  });

  it("pends a requiresManualReview line, forcing the claim to under_review with no ledger effect", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "SURGERY", coinsuranceRate: 0, requiresManualReview: true }],
    });

    const c = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "SURGERY", serviceDate: "2026-03-01", billedAmountCents: 500_000 }],
    });
    const v = await adjudicateClaim(c.id);

    expect(v.lineItems[0]!.status).toBe("pended");
    expect(v.status).toBe("under_review");
    expect(v.events.map((e) => e.type)).toContain("PENDED");

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.deductibleMetCents).toBe(0);
    expect(acc.benefitUsedByServiceType["SURGERY"]).toBeUndefined();
  });
});

describe("adjudicateClaim — serialization invariant", () => {
  it("concurrent claims for one member do not overspend a shared annual limit", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
    });

    // Two claims, different service dates (so not duplicates), each wanting the
    // full $2000 limit. Serialized, only $2000 total may be paid.
    const c1 = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 200_000 }],
    });
    const c2 = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-04-01", billedAmountCents: 200_000 }],
    });

    const [v1, v2] = await Promise.all([adjudicateClaim(c1.id), adjudicateClaim(c2.id)]);

    const totalPaid = v1.lineItems[0]!.payableCents! + v2.lineItems[0]!.payableCents!;
    expect(totalPaid).toBe(200_000); // never 400k

    const statuses = [v1.lineItems[0]!.status, v2.lineItems[0]!.status].sort();
    expect(statuses).toEqual(["approved", "denied"]); // one paid, one limit-exhausted

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["PT"]).toBe(200_000);
  });
});
