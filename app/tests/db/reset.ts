import { prisma } from "../../src/db/client.js";

/**
 * Truncate all tables between tests, FK-safe (children before parents).
 * SQLite has no TRUNCATE; deleteMany per table is fine at this scale.
 */
export async function resetDb(): Promise<void> {
  await prisma.event.deleteMany();
  await prisma.accumulatorEntry.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.lineItem.deleteMany();
  await prisma.claim.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.coverageRule.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.member.deleteMany();
}
