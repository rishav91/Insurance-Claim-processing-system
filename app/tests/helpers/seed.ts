import {
  createMember,
  createPlan,
  createPolicy,
  createProvider,
  type RuleInput,
} from "../../src/db/repositories.js";

/** Seed a member + provider + plan(+rules) + policy for orchestration specs. */
export async function seedScenario(opts: {
  rules: RuleInput[];
  deductibleAnnualCents?: number;
  planYear?: number;
  effectiveFrom?: string;
  effectiveTo?: string;
}) {
  const member = await createMember({ name: "Test Member", dateOfBirth: "1990-01-01" });
  const provider = await createProvider({ name: "Test Provider" });
  const plan = await createPlan({
    name: "Test Plan",
    planYear: opts.planYear ?? 2026,
    deductibleAnnualCents: opts.deductibleAnnualCents ?? 0,
    rules: opts.rules,
  });
  const policy = await createPolicy({
    memberId: member.id,
    planId: plan.id,
    effectiveFrom: opts.effectiveFrom ?? "2026-01-01",
    effectiveTo: opts.effectiveTo ?? "2026-12-31",
  });
  return { member, provider, plan, policy };
}
