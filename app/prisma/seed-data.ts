/**
 * Exported seed function — called by both prisma/seed.ts (standalone CLI) and
 * demo/run.ts (which resets + reseeds before running the walk-through).
 * Does NOT call prisma.$disconnect(); callers own the connection lifecycle.
 */
import {
  createMember,
  createPlan,
  createPolicy,
  createProvider,
} from "../src/db/repositories.js";
import { adjudicateClaim, submitClaim } from "../src/services/claims.js";

export interface SeedResult {
  provider: { id: string; name: string };
  plans: {
    goldPPO2026: { id: string; name: string };
    silverHMO2026: { id: string; name: string };
    bronzeHDHP2025: { id: string; name: string };
    bronzeHDHP2026: { id: string; name: string };
  };
  members: {
    alice: { id: string; name: string };
    bob: { id: string; name: string };
    carol: { id: string; name: string };
    david: { id: string; name: string };
    eve: { id: string; name: string };
  };
}

async function seedClaim(
  memberId: string,
  providerId: string,
  lines: { serviceType: string; serviceDate: string; billedAmountCents: number }[],
) {
  const submitted = await submitClaim({ memberId, providerId, lines });
  return adjudicateClaim(submitted.id);
}

export async function seedReferenceData(): Promise<SeedResult> {
  const provider = await createProvider({ name: "City Medical Center" });

  // ── Plans ──────────────────────────────────────────────────────────────────

  const goldPPO2026 = await createPlan({
    name: "Gold PPO 2026",
    planYear: 2026,
    deductibleAnnualCents: 100_000,
    rules: [
      { serviceType: "OFFICE_VISIT", copayCents: 3_000 },
      { serviceType: "PT", coinsuranceRate: 0.2, annualLimitCents: 200_000 },
      { serviceType: "SURGERY", coinsuranceRate: 0, annualLimitCents: 1_000_000, requiresManualReview: true },
      { serviceType: "PREVENTIVE", coinsuranceRate: 0 },
      { serviceType: "IMAGING", coinsuranceRate: 0.1, allowedAmountCents: 50_000, annualLimitCents: 500_000 },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  const silverHMO2026 = await createPlan({
    name: "Silver HMO 2026",
    planYear: 2026,
    deductibleAnnualCents: 300_000,
    rules: [
      { serviceType: "OFFICE_VISIT", copayCents: 5_000 },
      { serviceType: "PT", coinsuranceRate: 0.3, annualLimitCents: 150_000 },
      { serviceType: "SURGERY", coinsuranceRate: 0.2, annualLimitCents: 800_000, requiresManualReview: true },
      { serviceType: "LAB", coinsuranceRate: 0.15, annualLimitCents: 200_000 },
      { serviceType: "PREVENTIVE", coinsuranceRate: 0 },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  const bronzeHDHP2025 = await createPlan({
    name: "Bronze HDHP 2025",
    planYear: 2025,
    deductibleAnnualCents: 500_000,
    rules: [
      { serviceType: "OFFICE_VISIT", coinsuranceRate: 0.2 },
      { serviceType: "PT", coinsuranceRate: 0.3 },
      { serviceType: "SURGERY", coinsuranceRate: 0.2, requiresManualReview: true },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  const bronzeHDHP2026 = await createPlan({
    name: "Bronze HDHP 2026",
    planYear: 2026,
    deductibleAnnualCents: 500_000,
    rules: [
      { serviceType: "OFFICE_VISIT", coinsuranceRate: 0.2 },
      { serviceType: "PT", coinsuranceRate: 0.3, annualLimitCents: 150_000 },
      { serviceType: "SURGERY", coinsuranceRate: 0.2, requiresManualReview: true },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  // ── Members & prior-history claims ─────────────────────────────────────────

  // Alice: deductible $1,000 met · PT $400/$2,000 used
  const alice = await createMember({ name: "Alice Chen", dateOfBirth: "1985-03-12" });
  await createPolicy({ memberId: alice.id, planId: goldPPO2026.id, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" });
  await seedClaim(alice.id, provider.id, [{ serviceType: "PT", serviceDate: "2026-01-15", billedAmountCents: 150_000 }]);

  // Bob: deductible $3,000 met · PT $1,400/$1,500 used (near cap)
  const bob = await createMember({ name: "Bob Patel", dateOfBirth: "1978-07-22" });
  await createPolicy({ memberId: bob.id, planId: silverHMO2026.id, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" });
  await seedClaim(bob.id, provider.id, [{ serviceType: "PT", serviceDate: "2026-01-20", billedAmountCents: 500_000 }]);

  // Carol: expired 2025 policy + active 2026 renewal · 2025 deductible $600/$5,000
  const carol = await createMember({ name: "Carol Santos", dateOfBirth: "1990-11-05" });
  await createPolicy({ memberId: carol.id, planId: bronzeHDHP2025.id, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" });
  await createPolicy({ memberId: carol.id, planId: bronzeHDHP2026.id, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" });
  await seedClaim(carol.id, provider.id, [{ serviceType: "PT", serviceDate: "2025-09-10", billedAmountCents: 60_000 }]);

  // David: deductible $1,500/$3,000 partially met · no benefit limits touched
  const david = await createMember({ name: "David Kim", dateOfBirth: "1965-01-30" });
  await createPolicy({ memberId: david.id, planId: silverHMO2026.id, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" });
  await seedClaim(david.id, provider.id, [{ serviceType: "OFFICE_VISIT", serviceDate: "2026-01-10", billedAmountCents: 150_000 }]);

  // Eve: clean slate — concurrent scenario target
  const eve = await createMember({ name: "Eve Rodriguez", dateOfBirth: "1992-06-18" });
  await createPolicy({ memberId: eve.id, planId: goldPPO2026.id, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" });

  return {
    provider: { id: provider.id, name: provider.name },
    plans: {
      goldPPO2026:    { id: goldPPO2026.id,    name: goldPPO2026.name },
      silverHMO2026:  { id: silverHMO2026.id,  name: silverHMO2026.name },
      bronzeHDHP2025: { id: bronzeHDHP2025.id, name: bronzeHDHP2025.name },
      bronzeHDHP2026: { id: bronzeHDHP2026.id, name: bronzeHDHP2026.name },
    },
    members: {
      alice: { id: alice.id, name: alice.name },
      bob:   { id: bob.id,   name: bob.name },
      carol: { id: carol.id, name: carol.name },
      david: { id: david.id, name: david.name },
      eve:   { id: eve.id,   name: eve.name },
    },
  };
}
