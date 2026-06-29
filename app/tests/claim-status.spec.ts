import { describe, it, expect } from "vitest";
import { deriveClaimStatus } from "../src/domain/claim-status.js";

/**
 * Behavior specs for the derived claim-status rollup (domain-model.md §4).
 * deriveClaimStatus is a total pure function over the multiset of line states,
 * evaluated by first-matching precedence.
 */
describe("deriveClaimStatus — rollup precedence", () => {
  it("is under_review when any line is pended", () => {
    expect(deriveClaimStatus(["approved", "pended", "denied"])).toBe("under_review");
  });

  it("is under_review when any line is disputed", () => {
    expect(deriveClaimStatus(["approved", "disputed"])).toBe("under_review");
  });

  it("is under_review when all lines are pended", () => {
    expect(deriveClaimStatus(["pended", "pended"])).toBe("under_review");
  });

  it("is paid only when all lines are paid", () => {
    expect(deriveClaimStatus(["paid", "paid"])).toBe("paid");
  });

  it("is denied when all lines are denied", () => {
    expect(deriveClaimStatus(["denied", "denied"])).toBe("denied");
  });

  it("is approved when all lines are approved", () => {
    expect(deriveClaimStatus(["approved", "approved"])).toBe("approved");
  });

  it("is partially_approved on a mix of approved and denied", () => {
    expect(deriveClaimStatus(["approved", "denied"])).toBe("partially_approved");
  });

  it("is partially_approved when any line is partially_approved", () => {
    expect(deriveClaimStatus(["partially_approved", "approved"])).toBe("partially_approved");
  });

  it("pended precedence wins over a paid line (cannot finalize)", () => {
    expect(deriveClaimStatus(["paid", "pended"])).toBe("under_review");
  });
});
