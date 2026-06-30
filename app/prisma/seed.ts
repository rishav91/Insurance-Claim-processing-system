/**
 * Reference data seed for the demo (roadmap Phase 6).
 *
 * Run once on a clean DB:
 *   npx prisma db push        # sync schema
 *   npm run db:seed            # run this script
 *
 * Prints a JSON block of every seeded ID so demo scripts can reference them
 * without hard-coding values.
 *
 * Members are designed to land in varied accumulator states so each demo
 * scenario starts from a realistic mid-year position rather than a blank slate.
 */
import { prisma } from "../src/db/client.js";
import {
  createMember,
  createPlan,
  createPolicy,
  createProvider,
} from "../src/db/repositories.js";
import { adjudicateClaim, submitClaim } from "../src/services/claims.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Submit + immediately adjudicate — used for seeding prior-history claims. */
async function seedClaim(
  memberId: string,
  providerId: string,
  lines: { serviceType: string; serviceDate: string; billedAmountCents: number }[],
) {
  const submitted = await submitClaim({ memberId, providerId, lines });
  return adjudicateClaim(submitted.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding reference data…\n");

  // ── Shared provider ──────────────────────────────────────────────────────
  const provider = await createProvider({ name: "City Medical Center" });

  // ── Plans ────────────────────────────────────────────────────────────────

  /**
   * Plan A — Gold PPO 2026
   * Full-featured: copay (OFFICE_VISIT), coinsurance + annual limit (PT),
   * manual-review gate (SURGERY), fee-schedule reduction (IMAGING),
   * 100%-covered preventive (PREVENTIVE), hard exclusion (COSMETIC).
   * Deductible: $1,000.
   */
  const goldPPO2026 = await createPlan({
    name: "Gold PPO 2026",
    planYear: 2026,
    deductibleAnnualCents: 100_000,
    rules: [
      // $30 flat copay; no annual limit — straightforward cost-share showcase
      { serviceType: "OFFICE_VISIT", copayCents: 3_000 },
      // 20% coinsurance, $2,000 annual benefit cap — the partial-approval target
      { serviceType: "PT", coinsuranceRate: 0.2, annualLimitCents: 200_000 },
      // Fully covered (0% coinsurance) but gated behind manual review; $10,000 limit
      { serviceType: "SURGERY", coinsuranceRate: 0, annualLimitCents: 1_000_000, requiresManualReview: true },
      // 100% covered after deductible (coinsuranceRate 0 = no member cost-share)
      { serviceType: "PREVENTIVE", coinsuranceRate: 0 },
      // 10% coinsurance, contracted rate $500 (fee schedule), $5,000 annual cap
      { serviceType: "IMAGING", coinsuranceRate: 0.1, allowedAmountCents: 50_000, annualLimitCents: 500_000 },
      // Hard exclusion — every line denied at gate 2 regardless of anything else
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  /**
   * Plan B — Silver HMO 2026
   * Higher deductible ($3,000), higher cost-share percentages, shorter PT limit
   * ($1,500). Includes LAB as a second limit-bearing service type.
   */
  const silverHMO2026 = await createPlan({
    name: "Silver HMO 2026",
    planYear: 2026,
    deductibleAnnualCents: 300_000,
    rules: [
      // $50 copay; deductible applies first, so pre-deductible office visits cost nothing to the insurer
      { serviceType: "OFFICE_VISIT", copayCents: 5_000 },
      // 30% coinsurance, tight $1,500 cap — David + Bob demo the near-limit scenario
      { serviceType: "PT", coinsuranceRate: 0.3, annualLimitCents: 150_000 },
      // 20% coinsurance + manual review; $8,000 cap
      { serviceType: "SURGERY", coinsuranceRate: 0.2, annualLimitCents: 800_000, requiresManualReview: true },
      // 15% coinsurance; $2,000 cap — distinct service type for accumulator clarity
      { serviceType: "LAB", coinsuranceRate: 0.15, annualLimitCents: 200_000 },
      // 100% covered after deductible
      { serviceType: "PREVENTIVE", coinsuranceRate: 0 },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  /**
   * Plan C — Bronze HDHP 2025  (EXPIRED — effectiveTo 2025-12-31)
   * High-deductible plan without PT annual limit; seeds Carol's 2025 accumulator.
   */
  const bronzeHDHP2025 = await createPlan({
    name: "Bronze HDHP 2025",
    planYear: 2025,
    deductibleAnnualCents: 500_000,
    rules: [
      { serviceType: "OFFICE_VISIT", coinsuranceRate: 0.2 },
      // No annual limit — all spend goes to deductible; useful for year-boundary demo
      { serviceType: "PT", coinsuranceRate: 0.3 },
      { serviceType: "SURGERY", coinsuranceRate: 0.2, requiresManualReview: true },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  /**
   * Plan D — Bronze HDHP 2026  (Carol's renewal; non-overlapping with Plan C)
   * Same deductible as 2025; PT gains a $1,500 annual limit in the new year —
   * demonstrates that a renewal can alter the benefit design.
   */
  const bronzeHDHP2026 = await createPlan({
    name: "Bronze HDHP 2026",
    planYear: 2026,
    deductibleAnnualCents: 500_000,
    rules: [
      { serviceType: "OFFICE_VISIT", coinsuranceRate: 0.2 },
      // PT limit added for 2026 — same rule, tighter cap
      { serviceType: "PT", coinsuranceRate: 0.3, annualLimitCents: 150_000 },
      { serviceType: "SURGERY", coinsuranceRate: 0.2, requiresManualReview: true },
      { serviceType: "COSMETIC", excluded: true },
    ],
  });

  // ── Members, Policies, and Prior-History Claims ──────────────────────────

  /**
   * Alice Chen — Gold PPO 2026
   *
   * Prior-history claim: PT billed $1,500
   *   allowed          = $1,500   (no fee schedule on PT)
   *   deductibleApplied= $1,000   (absorbs full annual deductible)
   *   costShareBase    = $500
   *   coinsurance 20%  = $100     → member pays
   *   payable          = $400     → insurer pays
   *   status           = approved
   *
   * State going into the demo:
   *   deductibleMet    = $1,000   (fully met — no more deductible on any new line)
   *   benefitUsed[PT]  = $400     ($1,600 of $2,000 PT limit remaining)
   *
   * Good for: coinsurance-only scenarios (deductible gone), partial-approval
   * when a new PT claim pushes past the remaining $1,600.
   */
  const alice = await createMember({ name: "Alice Chen", dateOfBirth: "1985-03-12" });
  await createPolicy({
    memberId: alice.id,
    planId: goldPPO2026.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });
  await seedClaim(alice.id, provider.id, [
    { serviceType: "PT", serviceDate: "2026-01-15", billedAmountCents: 150_000 },
  ]);

  /**
   * Bob Patel — Silver HMO 2026
   *
   * Prior-history claim: PT billed $5,000
   *   allowed          = $5,000
   *   deductibleApplied= $3,000   (absorbs full annual deductible)
   *   costShareBase    = $2,000
   *   coinsurance 30%  = $600     → member pays
   *   payableBeforeLimit= $1,400
   *   annualLimit      = $1,500   → $1,400 is within limit
   *   payable          = $1,400
   *   status           = approved
   *
   * State going into the demo:
   *   deductibleMet    = $3,000   (fully met)
   *   benefitUsed[PT]  = $1,400   ($100 of $1,500 PT limit remaining — near cap)
   *
   * Good for: any new PT line ≥ ~$143 billed causes partial approval ($100 paid,
   * excess denied). Clear illustration of the annual-limit overflow scenario.
   */
  const bob = await createMember({ name: "Bob Patel", dateOfBirth: "1978-07-22" });
  await createPolicy({
    memberId: bob.id,
    planId: silverHMO2026.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });
  await seedClaim(bob.id, provider.id, [
    { serviceType: "PT", serviceDate: "2026-01-20", billedAmountCents: 500_000 },
  ]);

  /**
   * Carol Santos — Bronze HDHP, expired 2025 policy + active 2026 renewal
   *
   * Two non-overlapping policies:
   *   2025 policy (Plan C) — effectiveTo 2025-12-31  [EXPIRED]
   *   2026 policy (Plan D) — effectiveFrom 2026-01-01 [ACTIVE]
   *
   * Prior-history claim (in 2025): PT dated 2025-09-10, billed $600
   *   allowed          = $600
   *   deductibleApplied= $600     (annual deductible $5,000 — only $600 absorbed)
   *   costShareBase    = $0
   *   payable          = $0
   *   status           = approved
   *
   * State going into the demo:
   *   2025 deductibleMet = $600   ($4,400 would remain — but the 2025 policy expires)
   *   2026 accumulator   = fresh  (new plan year, new deductible)
   *
   * Good for:
   *   - Year-boundary claims: a Dec-2025 line uses the 2025 accumulator + expired
   *     plan's rules; a Jan-2026 line uses the 2026 plan's rules + a fresh slate.
   *   - Showing an out-of-window date (a 2027 line) → COVERAGE_INACTIVE.
   *   - Demonstrating policy renewal: the 2026 PT limit ($1,500) didn't exist in 2025.
   */
  const carol = await createMember({ name: "Carol Santos", dateOfBirth: "1990-11-05" });
  await createPolicy({
    memberId: carol.id,
    planId: bronzeHDHP2025.id,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  });
  await createPolicy({
    memberId: carol.id,
    planId: bronzeHDHP2026.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });
  await seedClaim(carol.id, provider.id, [
    { serviceType: "PT", serviceDate: "2025-09-10", billedAmountCents: 60_000 },
  ]);

  /**
   * David Kim — Silver HMO 2026
   *
   * Prior-history claim: OFFICE_VISIT billed $1,500
   *   allowed          = $1,500   (no fee schedule)
   *   deductibleApplied= $1,500   (deductible $3,000 — absorbs the full billed amount)
   *   costShareBase    = $0       → copay doesn't apply (nothing left after deductible)
   *   payable          = $0
   *   status           = approved
   *
   * State going into the demo:
   *   deductibleMet    = $1,500   ($1,500 of $3,000 remaining)
   *   benefitUsed      = {}       (no insurer payment yet — all was deductible)
   *
   * Good for: a new PT or LAB claim that still has deductible to absorb — shows the
   * mid-deductible cost-share calculation (deductible chews into the new claim, then
   * coinsurance applies to the rest). Contrasts with Bob where deductible is exhausted.
   */
  const david = await createMember({ name: "David Kim", dateOfBirth: "1965-01-30" });
  await createPolicy({
    memberId: david.id,
    planId: silverHMO2026.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });
  await seedClaim(david.id, provider.id, [
    { serviceType: "OFFICE_VISIT", serviceDate: "2026-01-10", billedAmountCents: 150_000 },
  ]);

  /**
   * Eve Rodriguez — Gold PPO 2026, clean slate
   *
   * No prior claims. All accumulators at zero.
   *
   * Good for: concurrent-adjudication stress tests (scenarios 6-A, 6-B, 6-F in
   * demo-scenarios.md) where a fresh member lets the limit invariant show cleanly
   * without prior-history noise. Also the fee-schedule (IMAGING) and preventive-care
   * (PREVENTIVE) happy-path demos.
   */
  const eve = await createMember({ name: "Eve Rodriguez", dateOfBirth: "1992-06-18" });
  await createPolicy({
    memberId: eve.id,
    planId: goldPPO2026.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
  });

  // ── Summary ──────────────────────────────────────────────────────────────

  const summary = {
    provider: { id: provider.id, name: provider.name },
    plans: {
      goldPPO2026:    { id: goldPPO2026.id,    name: goldPPO2026.name },
      silverHMO2026:  { id: silverHMO2026.id,  name: silverHMO2026.name },
      bronzeHDHP2025: { id: bronzeHDHP2025.id, name: bronzeHDHP2025.name, note: "EXPIRED" },
      bronzeHDHP2026: { id: bronzeHDHP2026.id, name: bronzeHDHP2026.name },
    },
    members: {
      alice: {
        id: alice.id,
        name: "Alice Chen",
        plan: "Gold PPO 2026",
        accumulatorState: "deductible $1,000/$1,000 met · PT $400/$2,000 used · $1,600 PT limit remaining",
      },
      bob: {
        id: bob.id,
        name: "Bob Patel",
        plan: "Silver HMO 2026",
        accumulatorState: "deductible $3,000/$3,000 met · PT $1,400/$1,500 used · $100 PT limit remaining (near cap)",
      },
      carol: {
        id: carol.id,
        name: "Carol Santos",
        plan: "Bronze HDHP 2025 (expired) + Bronze HDHP 2026 (active)",
        accumulatorState: "2025: deductible $600/$5,000 met · 2026: all zero (fresh plan year)",
      },
      david: {
        id: david.id,
        name: "David Kim",
        plan: "Silver HMO 2026",
        accumulatorState: "deductible $1,500/$3,000 partially met · no benefit limits touched",
      },
      eve: {
        id: eve.id,
        name: "Eve Rodriguez",
        plan: "Gold PPO 2026",
        accumulatorState: "all zero — clean slate",
      },
    },
  };

  console.log("✅ Seed complete.\n");
  console.log(JSON.stringify(summary, null, 2));

  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
