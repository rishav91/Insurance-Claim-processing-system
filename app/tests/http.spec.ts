import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resetDb } from "./db/reset.js";
import { seedScenario } from "./helpers/seed.js";
import { buildApp } from "../src/http/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

describe("HTTP — submit & adjudicate (roadmap Phase 5)", () => {
  it("submits a claim (201) then adjudicates it (200) with the adjudication payload", async () => {
    const { member, provider } = await seedScenario({
      // No deductible; PT pays 100% up to a $500 limit.
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 50_000 }],
    });

    const submit = await app.inject({
      method: "POST",
      url: "/v1/claims",
      payload: {
        memberId: member.id,
        providerId: provider.id,
        lineItems: [
          { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 80_000 },
        ],
      },
    });
    expect(submit.statusCode).toBe(201);
    const submitted = submit.json();
    expect(submitted.status).toBe("submitted");
    expect(submitted.lineItems[0].status).toBe("submitted");
    expect(submitted.lineItems[0].adjudication).toBeUndefined();

    const adj = await app.inject({
      method: "POST",
      url: `/v1/claims/${submitted.id}/adjudicate`,
    });
    expect(adj.statusCode).toBe(200);
    const adjudicated = adj.json();
    expect(adjudicated.status).toBe("partially_approved");
    const line = adjudicated.lineItems[0];
    expect(line.status).toBe("partially_approved");
    expect(line.adjudication.payableCents).toBe(50_000);
    expect(line.adjudication.reasons.map((r: { code: string }) => r.code)).toContain(
      "LIMIT_EXHAUSTED",
    );
  });

  it("returns 422 when lineItems is empty (no claim created)", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/claims",
      payload: { memberId: member.id, providerId: provider.id, lineItems: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBeDefined();
  });

  it("returns 404 for an unknown claim", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/claims/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when paying a claim that has not been adjudicated", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const submit = await app.inject({
      method: "POST",
      url: "/v1/claims",
      payload: {
        memberId: member.id,
        providerId: provider.id,
        lineItems: [
          { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 },
        ],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/claims/${submit.json().id}/pay`,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("HTTP — dispute & resolve (roadmap Phase 5)", () => {
  it("disputes a denied line (201) and overturns it via the resolve endpoint (200)", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "COSMETIC", excluded: true }],
    });
    const submit = await app.inject({
      method: "POST",
      url: "/v1/claims",
      payload: {
        memberId: member.id,
        providerId: provider.id,
        lineItems: [
          { serviceType: "COSMETIC", serviceDate: "2026-03-01", billedAmountCents: 40_000 },
        ],
      },
    });
    const claimId = submit.json().id;
    const adj = await app.inject({ method: "POST", url: `/v1/claims/${claimId}/adjudicate` });
    const lineId = adj.json().lineItems[0].id;
    expect(adj.json().lineItems[0].status).toBe("denied");

    const disputeRes = await app.inject({
      method: "POST",
      url: `/v1/lineitems/${lineId}/dispute`,
      payload: { reason: "obtained pre-authorization" },
    });
    expect(disputeRes.statusCode).toBe(201);
    const disputeId = disputeRes.json().id;
    expect(disputeRes.json().status).toBe("open");

    const resolveRes = await app.inject({
      method: "POST",
      url: `/v1/disputes/${disputeId}/resolve`,
      payload: {
        action: "overturn",
        overrides: [{ type: "FORCE_COVERED" }],
        note: "covered on appeal",
      },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().lineItems[0].status).toBe("approved");
  });

  it("returns 422 when two OVERRIDE_ALLOWED_AMOUNT directives conflict", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0 }],
    });
    const submit = await app.inject({
      method: "POST",
      url: "/v1/claims",
      payload: {
        memberId: member.id,
        providerId: provider.id,
        lineItems: [
          { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 50_000 },
        ],
      },
    });
    const claimId = submit.json().id;
    const adj = await app.inject({ method: "POST", url: `/v1/claims/${claimId}/adjudicate` });
    const lineId = adj.json().lineItems[0].id;
    const disputeRes = await app.inject({
      method: "POST",
      url: `/v1/lineitems/${lineId}/dispute`,
      payload: { reason: "appeal" },
    });
    const disputeId = disputeRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/disputes/${disputeId}/resolve`,
      payload: {
        action: "overturn",
        overrides: [
          { type: "OVERRIDE_ALLOWED_AMOUNT", valueCents: 1000 },
          { type: "OVERRIDE_ALLOWED_AMOUNT", valueCents: 2000 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("HTTP — member accumulators (roadmap Phase 5)", () => {
  it("reports live accumulator usage for a member + plan year", async () => {
    const { member, provider } = await seedScenario({
      rules: [{ serviceType: "PT", coinsuranceRate: 0, annualLimitCents: 200_000 }],
      deductibleAnnualCents: 100_000,
    });
    const submit = await app.inject({
      method: "POST",
      url: "/v1/claims",
      payload: {
        memberId: member.id,
        providerId: provider.id,
        lineItems: [
          { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 150_000 },
        ],
      },
    });
    await app.inject({ method: "POST", url: `/v1/claims/${submit.json().id}/adjudicate` });

    const res = await app.inject({
      method: "GET",
      url: `/v1/members/${member.id}/accumulators?planYear=2026`,
    });
    expect(res.statusCode).toBe(200);
    const acc = res.json();
    expect(acc.deductibleMetCents).toBe(100_000);
    expect(acc.benefitUsedByServiceType.PT).toBe(50_000);
    expect(acc.limitsByServiceType.PT).toBe(200_000);
  });
});
