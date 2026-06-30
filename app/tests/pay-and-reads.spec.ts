import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import { seedScenario } from "./helpers/seed.js";
import {
  adjudicateClaim,
  disputeLine,
  getDispute,
  getMemberAccumulators,
  listClaims,
  payClaim,
  submitClaim,
  type ClaimView,
} from "../src/services/claims.js";
import { ConflictError } from "../src/services/errors.js";

beforeEach(resetDb);

describe("payClaim (roadmap Phase 5)", () => {
  it("pays an approved claim: lines → paid, paidAmountCents = Σ payable, PAID event", async () => {
    const { member, provider } = await seedScenario({
      rules: [
        { serviceType: "OFFICE_VISIT", copayCents: 3_000 },
        { serviceType: "PT", coinsuranceRate: 0 },
      ],
    });
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        { serviceType: "OFFICE_VISIT", serviceDate: "2026-03-01", billedAmountCents: 20_000 },
        { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 },
      ],
    });
    await adjudicateClaim(submitted.id);

    const view = await payClaim(submitted.id);

    expect(view.status).toBe("paid");
    expect(view.lineItems.every((l) => l.status === "paid")).toBe(true);
    // 17000 (office visit after 3000 copay) + 50000 (PT full) = 67000
    expect(view.paidAmountCents).toBe(67_000);
    expect(view.paidAt).not.toBeNull();
    expect(view.events.map((e) => e.type)).toContain("PAID");
  });

  it("pays a partially-denied claim to a terminal paid state and rejects re-pay (409)", async () => {
    const { member, provider } = await seedScenario({
      rules: [
        { serviceType: "PT", coinsuranceRate: 0 },
        { serviceType: "COSMETIC", excluded: true },
      ],
    });
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 },
        { serviceType: "COSMETIC", serviceDate: "2026-03-01", billedAmountCents: 40_000 },
      ],
    });
    const adj = await adjudicateClaim(submitted.id);
    expect(adj.status).toBe("partially_approved"); // one approved, one denied

    const view = await payClaim(submitted.id);
    expect(view.status).toBe("paid"); // terminal despite the denied line
    expect(view.paidAmountCents).toBe(50_000); // only the PT line's payable
    const paidLine = view.lineItems.find((l) => l.serviceType === "PT")!;
    const deniedLine = view.lineItems.find((l) => l.serviceType === "COSMETIC")!;
    expect(paidLine.status).toBe("paid");
    expect(deniedLine.status).toBe("denied");

    // Re-paying must not clobber paidAmountCents — it is terminal.
    await expect(payClaim(submitted.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("concurrent payClaim on the SAME claim: one wins, one 409s, exactly one PAID event", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    await adjudicateClaim(submitted.id);

    const results = await Promise.allSettled([payClaim(submitted.id), payClaim(submitted.id)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // Exactly one PAID event — a double-commit would write two.
    const view = (fulfilled[0] as PromiseFulfilledResult<ClaimView>).value;
    expect(view.events.filter((e) => e.type === "PAID")).toHaveLength(1);
  });

  it("rejects paying a claim that is not in a payable state (409)", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    // Not adjudicated yet → not payable.
    await expect(payClaim(submitted.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("adjudicateClaim re-adjudication guard (roadmap Phase 5)", () => {
  it("rejects adjudicating an already-adjudicated claim (409)", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const submitted = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    await adjudicateClaim(submitted.id);
    await expect(adjudicateClaim(submitted.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("read endpoints (roadmap Phase 5)", () => {
  it("listClaims summarizes a member's claims with derived status and total payable", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
    });
    const s1 = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    await adjudicateClaim(s1.id);
    await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-04-01", billedAmountCents: 30_000 }],
    });

    const summaries = await listClaims(member.id);
    expect(summaries).toHaveLength(2);
    const adjudicated = summaries.find((c) => c.id === s1.id)!;
    expect(adjudicated.status).toBe("approved");
    expect(adjudicated.lineCount).toBe(1);
    expect(adjudicated.totalPayableCents).toBe(50_000);
  });

  it("getMemberAccumulators reports deductible + benefitUsed + limits live from the ledger", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
      deductibleAnnualCents: 100_000,
    });
    const s = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 150_000 }],
    });
    await adjudicateClaim(s.id);

    const acc = await getMemberAccumulators(member.id, 2026);
    expect(acc.deductibleAnnualCents).toBe(100_000);
    expect(acc.deductibleMetCents).toBe(100_000); // 150k bill, 100k deductible met
    expect(acc.benefitUsedByServiceType["PT"]).toBe(50_000); // 150k - 100k deductible
    expect(acc.limitsByServiceType["PT"]).toBe(200_000);
  });

  it("getDispute returns the dispute by id with parsed fields", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "COSMETIC", excluded: true }],
    });
    const s = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [{ serviceType: "COSMETIC", serviceDate: "2026-03-01", billedAmountCents: 50_000 }],
    });
    const adj = await adjudicateClaim(s.id);
    await disputeLine(adj.lineItems[0]!.id, "should be covered");

    const view = await getDispute(
      (await getDisputeIdForLine(adj.lineItems[0]!.id)),
    );
    expect(view).not.toBeNull();
    expect(view!.status).toBe("open");
    expect(view!.reason).toBe("should be covered");
  });
});

// helper: look up the dispute id for a line via the service read
async function getDisputeIdForLine(lineItemId: string): Promise<string> {
  const { prisma } = await import("../src/db/client.js");
  const d = await prisma.dispute.findUnique({ where: { lineItemId } });
  return d!.id;
}
