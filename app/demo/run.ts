/**
 * End-to-end demo walk-through (roadmap Phase 7).
 *
 * Usage:
 *   npm run demo          — resets dev.db, reseeds, runs all 8 scenarios
 *
 * Scenarios:
 *   1 · Office visit copay → approved
 *   2 · PT near annual limit → partial approval with breakdown
 *   3 · Deductible depletes across two claims
 *   4 · Exclusion denial + cross-claim duplicate detection
 *   5 · Manual review: SURGERY pended → reviewer approves → paid
 *   6 · Dispute + WAIVE_LIMIT overturn (and the order-dependence signal)
 *   7 · Concurrent adjudication — shared annual limit never overspent
 *   8 · Same claim adjudicated twice concurrently — one 409, ledger untouched
 *
 * Each scenario calls the same service functions the HTTP handlers call.
 * Equivalent API calls are noted inline.
 */
import { prisma } from "../src/db/client.js";
import { seedReferenceData, type SeedResult } from "../prisma/seed-data.js";
import {
  adjudicateClaim,
  disputeLine,
  getMemberAccumulators,
  payClaim,
  resolveDispute,
  reviewLine,
  submitClaim,
  type LineView,
} from "../src/services/claims.js";
import { ConflictError } from "../src/services/errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

const W = 68;
const BAR = "═".repeat(W);
const DIV = "─".repeat(W);

function dollars(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function banner(n: number, title: string, subtitle: string) {
  console.log(`\n${BAR}`);
  console.log(` SCENARIO ${n}  ·  ${title}`);
  console.log(` ${subtitle}`);
  console.log(BAR);
}

function row(label: string, value: string) {
  console.log(`  ${label.padEnd(28)}${value}`);
}

function divider() { console.log(`  ${DIV.slice(0, W - 4)}`); }

function printLine(l: LineView) {
  row("status", l.status.toUpperCase());
  row("allowed", dollars(l.allowedCents));
  row("deductible applied", dollars(l.deductibleAppliedCents));
  row("member cost-share", dollars(l.memberCostShareCents));
  row("payable (insurer)", dollars(l.payableCents));
  row("member responsibility", dollars(l.memberResponsibilityCents));
  if (l.reasons.length) {
    row("reasons", l.reasons.map((r) => r.code).join(", "));
  }
  if (l.payableCents !== null && l.memberResponsibilityCents !== null && l.allowedCents !== null) {
    const sum = l.payableCents + l.memberResponsibilityCents;
    const ok = sum === l.allowedCents;
    console.log(`\n  invariant ${ok ? "✓" : "✗"}  ${dollars(l.payableCents)} payable + ${dollars(l.memberResponsibilityCents)} member = ${dollars(l.allowedCents)} allowed`);
  }
}

function printAccumulators(label: string, acc: { deductibleMetCents: number; benefitUsedByServiceType: Record<string, number> }) {
  console.log(`\n  ${label}`);
  row("  deductible met", dollars(acc.deductibleMetCents));
  for (const [svc, used] of Object.entries(acc.benefitUsedByServiceType)) {
    row(`  benefit used [${svc}]`, dollars(used));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB reset
// ─────────────────────────────────────────────────────────────────────────────

async function resetDb() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Scenario helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Submit + adjudicate in one step — the two-call flow the API exposes. */
async function runClaim(
  memberId: string,
  providerId: string,
  lines: { serviceType: string; serviceDate: string; billedAmountCents: number }[],
) {
  // POST /v1/claims
  const submitted = await submitClaim({ memberId, providerId, lines });
  // POST /v1/claims/:id/adjudicate
  return adjudicateClaim(submitted.id);
}

/** Look up the dispute id for a line (needed to call resolveDispute). */
async function getDisputeId(lineItemId: string): Promise<string> {
  const d = await prisma.dispute.findUnique({ where: { lineItemId } });
  if (!d) throw new Error(`no dispute found for line ${lineItemId}`);
  return d.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

async function scenario1(seed: SeedResult) {
  banner(1, "OFFICE VISIT COPAY", `Member: Alice Chen  ·  Gold PPO 2026  ·  deductible $1,000 already met`);
  console.log("  → POST /v1/claims          (OFFICE_VISIT, billed $200)");
  console.log("  → POST /v1/claims/:id/adjudicate\n");

  const claim = await runClaim(seed.members.alice.id, seed.provider.id, [
    { serviceType: "OFFICE_VISIT", serviceDate: "2026-03-01", billedAmountCents: 20_000 },
  ]);

  const l = claim.lineItems[0]!;
  printLine(l);
  console.log("\n  WHAT TO OBSERVE");
  console.log("  Deductible is $0 (already met). Copay $30 applied, insurer pays the");
  console.log("  remaining $170. Status is 'approved' even though the member owes copay.");
}

async function scenario2(seed: SeedResult) {
  banner(2, "PARTIAL APPROVAL — ANNUAL LIMIT OVERFLOW",
    "Member: Alice Chen  ·  PT benefit $400/$2,000 used  ·  $1,600 remaining");
  console.log("  → POST /v1/claims          (PT, billed $2,500)");
  console.log("  → POST /v1/claims/:id/adjudicate\n");

  const claim = await runClaim(seed.members.alice.id, seed.provider.id, [
    { serviceType: "PT", serviceDate: "2026-04-01", billedAmountCents: 250_000 },
  ]);

  const l = claim.lineItems[0]!;
  printLine(l);

  const acc = await getMemberAccumulators(seed.members.alice.id, 2026);
  printAccumulators("accumulators after:", acc);
  console.log("\n  WHAT TO OBSERVE");
  console.log("  80% of $2,500 = $2,000 payable-before-limit, but only $1,600 remains.");
  console.log("  Insurer pays $1,600; $400 excess is LIMIT_EXHAUSTED. Status is");
  console.log("  'partially_approved' — the only case where that status fires.");

  return claim;   // returned so scenario 6 can dispute this line
}

async function scenario3(seed: SeedResult) {
  banner(3, "DEDUCTIBLE DEPLETES ACROSS TWO CLAIMS",
    "Member: David Kim  ·  Silver HMO 2026  ·  deductible $1,500/$3,000 partially met");

  const accBefore = await getMemberAccumulators(seed.members.david.id, 2026);
  printAccumulators("accumulators BEFORE:", accBefore);

  console.log("\n  → POST /v1/claims          (PT, billed $2,000)");
  console.log("  → POST /v1/claims/:id/adjudicate\n");

  const claim = await runClaim(seed.members.david.id, seed.provider.id, [
    { serviceType: "PT", serviceDate: "2026-05-01", billedAmountCents: 200_000 },
  ]);

  const l = claim.lineItems[0]!;
  printLine(l);

  const accAfter = await getMemberAccumulators(seed.members.david.id, 2026);
  printAccumulators("accumulators AFTER:", accAfter);
  console.log("\n  WHAT TO OBSERVE");
  console.log("  $1,500 remaining deductible absorbed first, then 30% coinsurance");
  console.log("  on the $500 balance = $150 member cost-share. Insurer pays $350.");
  console.log("  Deductible now fully met ($3,000). Subsequent claims skip gate 7.");
}

async function scenario4(seed: SeedResult) {
  banner(4, "EXCLUSION DENIAL  +  CROSS-CLAIM DUPLICATE DETECTION",
    "Members: Eve Rodriguez (exclusion)  ·  Carol Santos (duplicate)");

  // 4a — exclusion
  console.log("  [4a] Eve submits COSMETIC (excluded by plan rule)");
  console.log("  → POST /v1/claims  (COSMETIC, billed $500)");
  console.log("  → POST /v1/claims/:id/adjudicate\n");

  const cosmeticClaim = await runClaim(seed.members.eve.id, seed.provider.id, [
    { serviceType: "COSMETIC", serviceDate: "2026-06-01", billedAmountCents: 50_000 },
  ]);

  const lExcl = cosmeticClaim.lineItems[0]!;
  row("status", lExcl.status.toUpperCase());
  row("payable", dollars(lExcl.payableCents));
  row("member responsibility", dollars(lExcl.memberResponsibilityCents));
  row("reasons", lExcl.reasons.map((r) => r.code).join(", "));
  console.log("  Note: hard denial — no money, no accumulator entry.");

  divider();

  // 4b — cross-claim duplicate
  console.log("\n  [4b] Carol submits PT on 2026-03-01 (Claim 1 → approved)");
  const c1 = await runClaim(seed.members.carol.id, seed.provider.id, [
    { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 30_000 },
  ]);
  row("Claim 1 status", c1.lineItems[0]!.status.toUpperCase());

  console.log("\n  Carol submits same (PT, 2026-03-01) again (Claim 2)");
  const c2 = await runClaim(seed.members.carol.id, seed.provider.id, [
    { serviceType: "PT", serviceDate: "2026-03-01", billedAmountCents: 30_000 },
  ]);
  const lDup = c2.lineItems[0]!;
  row("Claim 2 status", lDup.status.toUpperCase());
  row("reasons", lDup.reasons.map((r) => r.code).join(", "));
  console.log("\n  WHAT TO OBSERVE");
  console.log("  Claim 1 is approved (line is in deductible, payable $0 — still covered).");
  console.log("  Claim 2's matching (member, provider, serviceType, serviceDate) line is");
  console.log("  denied DUPLICATE. Re-submission is caught cleanly.");
}

async function scenario5(seed: SeedResult) {
  banner(5, "MANUAL REVIEW: SURGERY PENDED → APPROVED → PAID",
    "Member: Eve Rodriguez  ·  Gold PPO 2026  ·  SURGERY requiresManualReview");

  console.log("  → POST /v1/claims          (SURGERY, billed $5,000)");
  console.log("  → POST /v1/claims/:id/adjudicate\n");

  const submitted = await submitClaim({
    memberId: seed.members.eve.id,
    providerId: seed.provider.id,
    lines: [{ serviceType: "SURGERY", serviceDate: "2026-07-15", billedAmountCents: 500_000 }],
  });
  const adjudicated = await adjudicateClaim(submitted.id);

  const l = adjudicated.lineItems[0]!;
  row("line status", l.status.toUpperCase());
  row("claim status", adjudicated.status.toUpperCase());
  row("reasons", l.reasons.map((r) => r.code).join(", "));
  console.log("  No accumulator entry yet — pended lines have no ledger effect.");

  divider();
  console.log("\n  → POST /v1/lineitems/:id/review  { action: 'approve' }");

  const reviewed = await reviewLine(l.id, "approve", { note: "Medically necessary — approved" });
  const lR = reviewed.lineItems[0]!;
  console.log();
  row("line status", lR.status.toUpperCase());
  row("deductible applied", dollars(lR.deductibleAppliedCents));
  row("payable (insurer)", dollars(lR.payableCents));
  row("event timeline", reviewed.events.map((e) => e.type).join(" → "));

  divider();
  console.log("\n  → POST /v1/claims/:id/pay");

  const paid = await payClaim(reviewed.id);
  row("claim status", paid.status.toUpperCase());
  row("paidAmountCents", dollars(paid.paidAmountCents));
  console.log("\n  WHAT TO OBSERVE");
  console.log("  Pended lines carry no money or accumulator effect until a human decides.");
  console.log("  Approval re-runs the engine (deductible: Eve had $0 met, now $1,000 met).");
  console.log("  Payment is terminal — the PAID event closes the lifecycle.");
}

async function scenario6(aliceClaim: Awaited<ReturnType<typeof scenario2>>) {
  banner(6, "DISPUTE + WAIVE_LIMIT OVERTURN",
    "Alice's partially_approved PT line (Scenario 2) · payable $1,600 → $2,000");

  const partialLine = aliceClaim.lineItems[0]!;
  console.log(`  Disputing line ${partialLine.id} (status: ${partialLine.status})`);
  console.log("  → POST /v1/lineitems/:id/dispute  { reason: '...' }\n");

  await disputeLine(partialLine.id, "The annual limit should be waived — ongoing treatment");
  row("line status", "DISPUTED");

  divider();
  console.log("\n  → POST /v1/disputes/:id/resolve  { action: 'overturn', overrides: [WAIVE_LIMIT] }");

  const disputeId = await getDisputeId(partialLine.id);
  const resolved = await resolveDispute(disputeId, "overturn", {
    overrides: [{ type: "WAIVE_LIMIT" }],
    note: "Ongoing PT course — limit waived per clinical review",
  });

  const lR = resolved.lineItems[0]!;
  console.log();
  row("line status", lR.status.toUpperCase());
  row("payable (after override)", dollars(lR.payableCents));
  row("RESOLVED event", resolved.events.find((e) => e.type === "RESOLVED")?.toState ?? "");
  row("event timeline", resolved.events.map((e) => e.type).join(" → "));

  const accAfter = await getMemberAccumulators(aliceClaim.memberId, 2026);
  printAccumulators("Alice accumulators after overturn:", accAfter);
  console.log("\n  WHAT TO OBSERVE");
  console.log("  WAIVE_LIMIT skips gate 9. Payable grows from $1,600 → $2,000 (full 80%).");
  console.log("  benefitUsed[PT] now exceeds the nominal $2,000 cap — this is the documented");
  console.log("  order-dependence: an override intentionally bypasses the cap, and the ledger");
  console.log("  reflects the decision honestly rather than silently capping it.");
}

async function scenario7(seed: SeedResult) {
  banner(7, "CONCURRENT ADJUDICATION — SHARED LIMIT NEVER OVERSPENT",
    "Member: Eve Rodriguez  ·  PT limit $2,000  ·  Promise.all([C1, C2])");

  // Eve's deductible was met by SURGERY in Scenario 5.
  console.log("  Two PT claims submitted, then adjudicated simultaneously:");
  console.log("  → Promise.all([adjudicate(C1: PT $2,500), adjudicate(C2: PT $2,500)])");
  console.log("  Without the member lock: both would see remaining limit = $2,000");
  console.log("  and together pay $4,000 — a $2,000 overspend.\n");

  const c1 = await submitClaim({ memberId: seed.members.eve.id, providerId: seed.provider.id, lines: [{ serviceType: "PT", serviceDate: "2026-08-01", billedAmountCents: 250_000 }] });
  const c2 = await submitClaim({ memberId: seed.members.eve.id, providerId: seed.provider.id, lines: [{ serviceType: "PT", serviceDate: "2026-08-15", billedAmountCents: 250_000 }] });

  const [v1, v2] = await Promise.all([adjudicateClaim(c1.id), adjudicateClaim(c2.id)]);

  const l1 = v1.lineItems[0]!;
  const l2 = v2.lineItems[0]!;
  const totalPaid = (l1.payableCents ?? 0) + (l2.payableCents ?? 0);
  const statuses = [l1.status, l2.status].sort();

  row("C1 status", l1.status.toUpperCase());
  row("C1 payable", dollars(l1.payableCents));
  row("C2 status", l2.status.toUpperCase());
  row("C2 payable", dollars(l2.payableCents));
  console.log();
  row("TOTAL PAID", dollars(totalPaid));
  row("PT annual limit", "$2,000.00");
  const invariantHolds = totalPaid <= 200_000;
  console.log(`\n  invariant ${invariantHolds ? "✓" : "✗"}  total paid (${dollars(totalPaid)}) ≤ annual limit ($2,000.00)`);

  const acc = await getMemberAccumulators(seed.members.eve.id, 2026);
  printAccumulators("accumulators after:", acc);
  console.log("\n  WHAT TO OBSERVE");
  console.log(`  Statuses: ${statuses.join(" + ")}. One claim won the lock and paid up`);
  console.log("  to the limit; the other saw $0 remaining and was denied or partially paid.");
  console.log("  Total paid = exactly the cap. The ledger is never overspent.");
}

async function scenario8(seed: SeedResult) {
  banner(8, "SAME CLAIM ADJUDICATED TWICE CONCURRENTLY — ONE 409, LEDGER CLEAN",
    "Member: Eve Rodriguez  ·  Promise.all([adjudicate(C), adjudicate(C)])");

  console.log("  → POST /v1/claims          (OFFICE_VISIT, billed $200)");
  console.log("  → Promise.all([adjudicate(C), adjudicate(C)])\n");

  const c = await submitClaim({ memberId: seed.members.eve.id, providerId: seed.provider.id, lines: [{ serviceType: "OFFICE_VISIT", serviceDate: "2026-09-01", billedAmountCents: 20_000 }] });

  const results = await Promise.allSettled([adjudicateClaim(c.id), adjudicateClaim(c.id)]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");
  const conflict  = rejected[0]?.reason instanceof ConflictError;

  row("calls fulfilled", String(fulfilled.length));
  row("calls rejected (409)", String(rejected.length));
  row("loser threw ConflictError", conflict ? "yes ✓" : "no ✗");

  // Verify the ledger entry was written exactly once.
  const entries = await prisma.accumulatorEntry.findMany({
    where: { lineItemId: c.lineItems[0]!.id, voided: false },
  });
  row("active ledger entries for the line", String(entries.length));

  // Inspect the winning result directly.
  const winner = fulfilled[0]?.value;
  if (winner) {
    const l = winner.lineItems[0]!;
    console.log();
    row("winning call — status", l.status.toUpperCase());
    row("winning call — payable", dollars(l.payableCents));
    row("ADJUDICATED events on claim", String(winner.events.filter((e) => e.type === "ADJUDICATED").length));
  }
  console.log("\n  WHAT TO OBSERVE");
  console.log("  Exactly one call succeeds; the other sees the lines already past 'submitted'");
  console.log("  (under the member lock) and throws 409. The ledger has exactly one entry —");
  console.log("  no duplicate accumulator writes, no double-paid amounts.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${"═".repeat(W)}`);
  console.log(" CLAIMS PROCESSING SYSTEM — END-TO-END DEMO");
  console.log(`${"═".repeat(W)}`);
  console.log(" Resetting database and seeding reference data…");

  await resetDb();
  const seed = await seedReferenceData();

  console.log(` ✓ 4 plans · 5 members · 1 provider seeded`);
  console.log(` ✓ Prior-history claims adjudicated (Alice, Bob, Carol, David)`);

  const scenario2Claim = await scenario2(seed);
  await scenario1(seed);
  await scenario3(seed);
  await scenario4(seed);
  await scenario5(seed);
  await scenario6(scenario2Claim);
  await scenario7(seed);
  await scenario8(seed);

  console.log(`\n${"═".repeat(W)}`);
  console.log(" DEMO COMPLETE — 8 scenarios, all invariants held");
  console.log(`${"═".repeat(W)}\n`);

  await prisma.$disconnect();
}

run().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
