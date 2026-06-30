import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db/reset.js";
import { createMember, createPlan, createPolicy } from "../src/db/repositories.js";
import { ValidationError } from "../src/services/errors.js";

beforeEach(resetDb);

const member = () => createMember({ name: "M", dateOfBirth: "1990-01-01" });
const plan = (year: number) =>
  createPlan({ name: `Plan ${year}`, planYear: year, deductibleAnnualCents: 0, rules: [] });

/**
 * Invariant (decisions.md §"single active coverage"): a member holds at most one
 * policy active on any given date — enrollment windows must not overlap. The check
 * lives at the policy write boundary (seed), since SQLite can't express a range
 * exclusion constraint. Boundaries are inclusive, matching coverageActiveOn.
 */
describe("createPolicy — non-overlapping enrollment windows per member", () => {
  it("rejects a second policy whose window overlaps an existing one (same member)", async () => {
    const m = await member();
    const [a, b] = [await plan(2025), await plan(2026)];
    await createPolicy({
      memberId: m.id,
      planId: a.id,
      effectiveFrom: "2025-01-01",
      effectiveTo: "2025-12-31",
    });
    // Touches the prior window on its last day (inclusive) → overlap.
    await expect(
      createPolicy({
        memberId: m.id,
        planId: b.id,
        effectiveFrom: "2025-12-31",
        effectiveTo: "2026-12-31",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("allows consecutive non-overlapping windows (a clean renewal)", async () => {
    const m = await member();
    const [a, b] = [await plan(2025), await plan(2026)];
    await createPolicy({
      memberId: m.id,
      planId: a.id,
      effectiveFrom: "2025-01-01",
      effectiveTo: "2025-12-31",
    });
    await expect(
      createPolicy({
        memberId: m.id,
        planId: b.id,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      }),
    ).resolves.toBeDefined();
  });

  it("allows overlapping windows for DIFFERENT members", async () => {
    const [a, b] = [await member(), await member()];
    const p = await plan(2026);
    await createPolicy({
      memberId: a.id,
      planId: p.id,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    await expect(
      createPolicy({
        memberId: b.id,
        planId: p.id,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      }),
    ).resolves.toBeDefined();
  });
});
