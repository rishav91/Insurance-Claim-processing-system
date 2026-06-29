import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import { seedScenario } from "./helpers/seed.js";
import {
  adjudicateClaim,
  disputeLine,
  resolveDispute,
  submitClaim,
} from "../src/services/claims.js";
import { loadAccumulators } from "../src/db/repositories.js";
import { prisma } from "../src/db/client.js";

beforeEach(resetDb);

/** Submit + adjudicate a single-line claim, returning the line id and view. */
async function adjudicatedClaim(
  memberId: string,
  providerId: string,
  line: { serviceType: string; serviceDate: string; billedAmountCents: number },
) {
  const submitted = await submitClaim({ memberId, providerId, lines: [line] });
  const view = await adjudicateClaim(submitted.id);
  return { lineId: view.lineItems[0]!.id, view };
}

describe("disputeLine (roadmap Phase 4)", () => {
  it("moves a denied line to disputed, re-derives the claim to under_review, appends DISPUTED", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "COSMETIC", excluded: true }],
    });
    const { lineId } = await adjudicatedClaim(member.id, provider.id, {
      serviceType: "COSMETIC",
      serviceDate: "2026-03-01",
      billedAmountCents: 50_000,
    });

    const view = await disputeLine(lineId, "I believe this should be covered");

    expect(view.lineItems[0]!.status).toBe("disputed");
    expect(view.status).toBe("under_review");
    expect(view.events.map((e) => e.type)).toContain("DISPUTED");
  });

  it("refuses to dispute a paid line (terminal)", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const { lineId } = await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-03-01",
      billedAmountCents: 50_000,
    });
    // Simulate disbursement (the pay flow lands in Phase 5).
    await prisma.lineItem.update({ where: { id: lineId }, data: { status: "paid" } });

    await expect(disputeLine(lineId, "too late")).rejects.toThrow();
  });
});

describe("resolveDispute — overturn (roadmap Phase 4)", () => {
  it("overturns a limit-exhausted denial with WAIVE_LIMIT, pays it, and pushes benefitUsed past the cap (order-dependence)", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
    });
    // Claim 1 consumes the full $2000 limit.
    await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-03-01",
      billedAmountCents: 200_000,
    });
    // Claim 2 is denied — the limit is exhausted (no ledger entry, delta zero).
    const { lineId } = await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-04-01",
      billedAmountCents: 100_000,
    });

    await disputeLine(lineId, "please reconsider");
    const view = await resolveDispute(lineId, "overturn", {
      overrides: [{ type: "WAIVE_LIMIT" }],
      note: "goodwill exception",
    });

    const line = view.lineItems[0]!;
    expect(line.status).toBe("approved");
    expect(line.payableCents).toBe(100_000);

    // Documented limitation (decisions.md §7): the override pushes usage over the cap.
    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["PT"]).toBe(300_000);
    expect(acc.benefitUsedByServiceType["PT"]!).toBeGreaterThan(200_000);
  });

  it("combines {WAIVE_DEDUCTIBLE, WAIVE_LIMIT} in one resolution and applies both", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 50_000 }],
      deductibleAnnualCents: 40_000,
    });
    const { lineId, view: adj } = await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-03-01",
      billedAmountCents: 100_000,
    });
    // Normal: deductible 40k, base 60k, limit caps payable at 50k → partially_approved.
    expect(adj.lineItems[0]!.status).toBe("partially_approved");
    expect(adj.lineItems[0]!.payableCents).toBe(50_000);

    await disputeLine(lineId, "appeal");
    const view = await resolveDispute(lineId, "overturn", {
      overrides: [{ type: "WAIVE_DEDUCTIBLE" }, { type: "WAIVE_LIMIT" }],
    });

    const line = view.lineItems[0]!;
    expect(line.deductibleAppliedCents).toBe(0); // deductible waived
    expect(line.payableCents).toBe(100_000); // limit waived → full allowed
    expect(line.status).toBe("approved");
  });

  it("void-then-rewrite leaves member usage = Σ active entries; the old entry is kept voided", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
    });
    // Claim 1 uses $1500 of the $2000 limit.
    await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-03-01",
      billedAmountCents: 150_000,
    });
    // Claim 2 partially pays ($500 left) → had a $500 ledger entry.
    const { lineId } = await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-04-01",
      billedAmountCents: 100_000,
    });

    await disputeLine(lineId, "appeal");
    await resolveDispute(lineId, "overturn", { overrides: [{ type: "WAIVE_LIMIT" }] });

    // Old $500 entry voided, new $1000 entry active → 150k + 100k = 250k.
    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["PT"]).toBe(250_000);

    const activeSum = await prisma.accumulatorEntry.aggregate({
      where: { memberId: member.id, planYear: 2026, voided: false },
      _sum: { benefitDeltaCents: true },
    });
    expect(activeSum._sum.benefitDeltaCents).toBe(250_000); // no drift

    const voided = await prisma.accumulatorEntry.count({
      where: { lineItemId: lineId, voided: true },
    });
    expect(voided).toBe(1); // old entry retained for audit
  });
});

describe("resolveDispute — uphold (roadmap Phase 4)", () => {
  it("restores the original outcome and changes no accumulators", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 120_000 }],
    });
    // $1500 billed, $1200 limit → partially_approved, $1200 entry.
    const { lineId } = await adjudicatedClaim(member.id, provider.id, {
      serviceType: "PT",
      serviceDate: "2026-03-01",
      billedAmountCents: 150_000,
    });

    await disputeLine(lineId, "appeal");
    const view = await resolveDispute(lineId, "uphold", { note: "decision stands" });

    expect(view.lineItems[0]!.status).toBe("partially_approved"); // back to original
    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["PT"]).toBe(120_000); // unchanged
  });
});
