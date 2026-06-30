import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import {
  createMember,
  createPlan,
  createPolicy,
  createProvider,
} from "../src/db/repositories.js";
import { adjudicateClaim, submitClaim } from "../src/services/claims.js";

beforeEach(resetDb);

/**
 * A member who renewed: a 2025 plan where PT is EXCLUDED, then a (non-overlapping)
 * 2026 plan where PT is covered at 100%. The two enrollments are distinguishable by
 * outcome, so we can tell which plan adjudicated each line.
 */
async function memberWithRenewal() {
  const member = await createMember({ name: "M", dateOfBirth: "1990-01-01" });
  const provider = await createProvider({ name: "P" });
  const plan2025 = await createPlan({
    name: "2025",
    planYear: 2025,
    deductibleAnnualCents: 0,
    rules: [{ serviceType: "PT", excluded: true }],
  });
  const plan2026 = await createPlan({
    name: "2026",
    planYear: 2026,
    deductibleAnnualCents: 0,
    rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
  });
  await createPolicy({
    memberId: member.id,
    planId: plan2025.id,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  });
  await createPolicy({
    memberId: member.id,
    planId: plan2026.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });
  return { member, provider };
}

describe("adjudicateClaim — per-line policy resolution by service date", () => {
  it("adjudicates each line under the policy active on ITS service date", async () => {
    const { member, provider } = await memberWithRenewal();
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        { serviceType: "PT", serviceDate: "2025-06-01", billedAmountCents: 50_000 },
        { serviceType: "PT", serviceDate: "2026-06-01", billedAmountCents: 50_000 },
      ],
    });
    const view = await adjudicateClaim(submitted.id);
    const byDate = (d: string) => view.lineItems.find((l) => l.serviceDate === d)!;

    // 2025 line falls under the 2025 plan → PT excluded.
    expect(byDate("2025-06-01").status).toBe("denied");
    expect(byDate("2025-06-01").reasons.map((r) => r.code)).toContain("SERVICE_EXCLUDED");
    // 2026 line falls under the 2026 plan → PT covered, paid in full.
    expect(byDate("2026-06-01").status).toBe("approved");
    expect(byDate("2026-06-01").payableCents).toBe(50_000);
  });

  it("denies a line dated outside every policy window as COVERAGE_INACTIVE (known service)", async () => {
    const { member, provider } = await memberWithRenewal();
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        { serviceType: "PT", serviceDate: "2024-06-01", billedAmountCents: 50_000 },
      ],
    });
    const view = await adjudicateClaim(submitted.id);

    expect(view.lineItems[0]!.status).toBe("denied");
    expect(view.lineItems[0]!.reasons.map((r) => r.code)).toContain("COVERAGE_INACTIVE");
  });
});
