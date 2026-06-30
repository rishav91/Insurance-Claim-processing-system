/**
 * Standalone seed CLI — invoked by `npm run db:seed` / `prisma db seed`.
 * All logic lives in seed-data.ts; this file just drives it and disconnects.
 */
import { prisma } from "../src/db/client.js";
import { seedReferenceData } from "./seed-data.js";

console.log("Seeding reference data…\n");

seedReferenceData()
  .then((result) => {
    const summary = {
      provider: result.provider,
      plans: result.plans,
      members: {
        alice: { ...result.members.alice, accumulatorState: "deductible $1,000/$1,000 met · PT $400/$2,000 used · $1,600 PT limit remaining" },
        bob:   { ...result.members.bob,   accumulatorState: "deductible $3,000/$3,000 met · PT $1,400/$1,500 used · $100 PT limit remaining (near cap)" },
        carol: { ...result.members.carol, accumulatorState: "2025: deductible $600/$5,000 met · 2026: all zero (fresh plan year)" },
        david: { ...result.members.david, accumulatorState: "deductible $1,500/$3,000 partially met · no benefit limits touched" },
        eve:   { ...result.members.eve,   accumulatorState: "all zero — clean slate" },
      },
    };
    console.log("✅ Seed complete.\n");
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((e: unknown) => { console.error(e); process.exit(1); })
  .finally(() => { void prisma.$disconnect(); });
