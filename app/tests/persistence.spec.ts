import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import {
  createClaim,
  createMember,
  createPlan,
  createPolicy,
  createProvider,
  getPlanWithRules,
  getPoliciesForMember,
  loadAccumulators,
  voidAccumulatorEntryForLine,
  writeAccumulatorEntry,
} from "../src/db/repositories.js";

beforeEach(async () => {
  await resetDb();
});

describe("persistence — repository round-trip (roadmap Phase 2)", () => {
  it("creates a plan with rules and a policy, then reads them back intact", async () => {
    const member = await createMember({
      name: "Jane Doe",
      dateOfBirth: "1990-04-01",
    });
    const plan = await createPlan({
      name: "Gold PPO 2026",
      planYear: 2026,
      deductibleAnnualCents: 100_000,
      rules: [
        { serviceType: "OFFICE_VISIT", copayCents: 3_000 },
        { serviceType: "PT", coinsuranceRate: 0.2, annualLimitCents: 200_000 },
        { serviceType: "COSMETIC", excluded: true },
      ],
    });

    await createPolicy({
      memberId: member.id,
      planId: plan.id,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });

    const readBack = await getPlanWithRules(plan.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.deductibleAnnualCents).toBe(100_000);
    expect(readBack!.coverageRules).toHaveLength(3);

    const pt = readBack!.coverageRules.find((r) => r.serviceType === "PT");
    expect(pt?.coinsuranceRate).toBe(0.2);
    expect(pt?.annualLimitCents).toBe(200_000);

    const cosmetic = readBack!.coverageRules.find((r) => r.serviceType === "COSMETIC");
    expect(cosmetic?.excluded).toBe(true);

    const policies = await getPoliciesForMember(member.id);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.planId).toBe(plan.id);
    expect(policies[0]!.effectiveFrom).toBe("2026-01-01");
  });
});

describe("persistence — ledger-sum read (roadmap Phase 2)", () => {
  it("benefitUsed equals the sum of active (non-voided) AccumulatorEntry rows", async () => {
    const member = await createMember({ name: "John Roe", dateOfBirth: "1985-07-20" });
    const provider = await createProvider({ name: "City Clinic" });

    const claim = await createClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 },
        { serviceType: "PT", serviceDate: "2026-04-01", billedAmountCents: 80_000 },
        { serviceType: "PT", serviceDate: "2026-05-01", billedAmountCents: 30_000 },
      ],
    });
    const [l1, l2, l3] = claim.lineItems;

    await writeAccumulatorEntry({
      lineItemId: l1!.id,
      memberId: member.id,
      planYear: 2026,
      serviceType: "PT",
      deductibleDeltaCents: 40_000,
      benefitDeltaCents: 50_000,
    });
    await writeAccumulatorEntry({
      lineItemId: l2!.id,
      memberId: member.id,
      planYear: 2026,
      serviceType: "PT",
      deductibleDeltaCents: 0,
      benefitDeltaCents: 80_000,
    });
    // A third entry that we then void — it must NOT count toward usage.
    await writeAccumulatorEntry({
      lineItemId: l3!.id,
      memberId: member.id,
      planYear: 2026,
      serviceType: "PT",
      deductibleDeltaCents: 0,
      benefitDeltaCents: 30_000,
    });
    await voidAccumulatorEntryForLine(l3!.id);

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.deductibleMetCents).toBe(40_000);
    expect(acc.benefitUsedByServiceType["PT"]).toBe(130_000); // 50k + 80k, voided 30k excluded
  });

  it("scopes the ledger sum to the entry's plan year", async () => {
    const member = await createMember({ name: "Year Boundary", dateOfBirth: "1970-01-01" });
    const provider = await createProvider({ name: "Clinic" });
    const claim = await createClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        { serviceType: "PT", serviceDate: "2025-12-20", billedAmountCents: 20_000 },
        { serviceType: "PT", serviceDate: "2026-01-10", billedAmountCents: 20_000 },
      ],
    });
    const [dec, jan] = claim.lineItems;

    await writeAccumulatorEntry({
      lineItemId: dec!.id,
      memberId: member.id,
      planYear: 2025,
      serviceType: "PT",
      deductibleDeltaCents: 0,
      benefitDeltaCents: 20_000,
    });
    await writeAccumulatorEntry({
      lineItemId: jan!.id,
      memberId: member.id,
      planYear: 2026,
      serviceType: "PT",
      deductibleDeltaCents: 0,
      benefitDeltaCents: 20_000,
    });

    const acc2025 = await loadAccumulators(member.id, 2025);
    const acc2026 = await loadAccumulators(member.id, 2026);
    expect(acc2025.benefitUsedByServiceType["PT"]).toBe(20_000);
    expect(acc2026.benefitUsedByServiceType["PT"]).toBe(20_000);
  });
});
