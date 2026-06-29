import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import { seedScenario } from "./helpers/seed.js";
import { getClaim, submitClaim } from "../src/services/claims.js";

beforeEach(resetDb);

describe("submitClaim + getClaim (roadmap Phase 3)", () => {
  it("persists the claim and lines as submitted and appends a SUBMITTED event", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "OFFICE_VISIT", copayCents: 3000 }],
    });

    const view = await submitClaim({
      memberId: member.id,
      providerId: provider.id,
      lines: [
        {
          serviceType: "OFFICE_VISIT",
          serviceDate: "2026-03-01",
          billedAmountCents: 12000,
          diagnosisCode: "Z00.0",
        },
      ],
    });

    expect(view.status).toBe("submitted"); // derived: all lines submitted
    expect(view.lineItems).toHaveLength(1);
    expect(view.lineItems[0]!.status).toBe("submitted");
    expect(view.lineItems[0]!.payableCents).toBeNull(); // not adjudicated yet
    expect(view.events.map((e) => e.type)).toContain("SUBMITTED");

    const read = await getClaim(view.id);
    expect(read).not.toBeNull();
    expect(read!.status).toBe("submitted");
    expect(read!.lineItems[0]!.serviceType).toBe("OFFICE_VISIT");
    expect(read!.lineItems[0]!.billedAmountCents).toBe(12000);
  });

  it("returns null from getClaim for an unknown id", async () => {
    expect(await getClaim("does-not-exist")).toBeNull();
  });
});
