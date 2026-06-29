import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import { seedScenario } from "./helpers/seed.js";
import { adjudicateClaim, reviewLine, submitClaim } from "../src/services/claims.js";
import { loadAccumulators } from "../src/db/repositories.js";

beforeEach(resetDb);

/** Submit + adjudicate a single pended SURGERY line; return its id. */
async function pendedSurgery(memberId: string, providerId: string) {
  const submitted = await submitClaim({
    memberId,
    providerId,
    lines: [{ serviceType: "SURGERY", serviceDate: "2026-03-01", billedAmountCents: 100_000 }],
  });
  const view = await adjudicateClaim(submitted.id);
  expect(view.lineItems[0]!.status).toBe("pended");
  return view.lineItems[0]!.id;
}

describe("reviewLine — manual-review resolution (roadmap Phase 4)", () => {
  it("approve runs the engine, applies the delta, and appends RESOLVED", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "SURGERY", coinsuranceRate: 0, requiresManualReview: true }],
    });
    const lineId = await pendedSurgery(member.id, provider.id);

    const view = await reviewLine(lineId, "approve", { note: "medically necessary" });

    expect(view.lineItems[0]!.status).toBe("approved");
    expect(view.lineItems[0]!.payableCents).toBe(100_000);
    expect(view.status).toBe("approved");
    expect(view.events.map((e) => e.type)).toContain("RESOLVED");

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["SURGERY"]).toBe(100_000);
  });

  it("deny finalizes the line denied with no ledger effect", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "SURGERY", coinsuranceRate: 0, requiresManualReview: true }],
    });
    const lineId = await pendedSurgery(member.id, provider.id);

    const view = await reviewLine(lineId, "deny", { note: "not covered" });

    expect(view.lineItems[0]!.status).toBe("denied");
    expect(view.lineItems[0]!.payableCents).toBe(0);
    expect(view.status).toBe("denied");
    expect(view.events.map((e) => e.type)).toContain("RESOLVED");

    const acc = await loadAccumulators(member.id, 2026);
    expect(acc.benefitUsedByServiceType["SURGERY"]).toBeUndefined();
  });
});
