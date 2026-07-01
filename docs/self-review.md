# Self-Review

Honest take written after Phase 7, before submission.

---

## What I'm pleased with

**The engine has no database awareness.** `adjudicateLine` and `adjudicateClaim` take a snapshot of facts — rule, accumulators, override flags — and return a decision. No I/O, no Prisma, PHI-free by construction. Every behavior spec hits this function directly and references a section in `domain-model.md`. I'm happy with the test/domain parity.

**The accumulator is a ledger, not a counter.** Storing one `AccumulatorEntry` per finalized line and computing `benefitUsed` as a SUM was the right call. Dispute reversal is a single void — no inverse arithmetic, no drift. The audit trail now is a natural consequence, not extra work.

**Claim status can't be wrong.** `deriveClaimStatus` is a pure total function recomputed on every read — never stored. Partial approvals fall out of the precedence table naturally; you can't get `approved` while a line is still `denied`.

**Coverage is resolved per line by date of service.** An early draft did `findFirst` by member, which would silently return an arbitrary enrollment for anyone who'd renewed mid-year. I caught it: now each line independently resolves the policy whose effective window contains its own `serviceDate`. The right policy is derived, not asserted by the submitter.

---

## What's rough

**Resolution is order-dependent across claims.** When a dispute overturn or manual-review approval re-adjudicates a line, it reads the *current* accumulator — not the state at original adjudication. If the cap got consumed by later claims in the interim, the overturn can push `benefitUsed` past the limit. I've made this visible in the demo and in a behavior spec for the dispute path. The same gap exists for manual-review approval but isn't separately spec'd. There's no consistency report or cascade.

**One dispute per line, no appeal history.** A second dispute attempt returns 409. Real adjudication systems track multi-level appeals. The fix is small (drop the unique constraint, add an "open dispute" guard) — I just didn't have time.

**SQLite for portability, PostgreSQL for correctness.** SQLite means two concurrent claims for different members also serialize — they share no resources but still queue. Fine for a local demo, wrong for production. The concurrency design is already written against a Postgres `SELECT … FOR UPDATE` target; SQLite is the approximation, and I've documented the seam.

**`services/claims.ts` is a 940-line monolith.** The domain core is cleanly extractable. The orchestration layer isn't — it mixes claim lifecycle, disputes, manual-review, and accumulator reporting in one file with no module separation. The member-row lock also spans all of these in a single transaction, so pulling any subsystem into a separate service would break the "lock → sum → decide → write" invariant without a saga replacement.

**`CoverageRule` rows are mutable.** A rule change after adjudication silently affects any re-run of that line. Real payer systems require prospective-only benefit changes with effective-dated snapshots. The financial breakdown on `LineItem` at first adjudication is frozen and correct; a re-adjudication reading the current rule is where the gap lives.

---

## What I'd do next with more time

1. **Cross-claim consistency report** — after any resolution, flag if `benefitUsed` now exceeds the cap and which claims are affected. The order-dependence gap is real.
2. **Out-of-pocket maximum** — it's one more `AccumulatorEntry` type and one more pipeline step. The architecture already supports it.
3. **Full rule trace** — `reasons[]` currently only includes money-affecting steps. A full trace (every gate, pass or no-op) would make the audit story much stronger.
4. **Consistent repository layer** — `db/repositories.ts` abstracts the accumulator ledger, but `services/claims.ts` calls `prisma.*` directly for everything else. A future DB swap should be a boundary change, not a grep-and-replace.

---

## Where I steered the AI

**Plan and Policy were the same thing.** The first draft put coverage rules, enrollment dates, and the deductible on a single entity. I pushed back: the moment two members share the same benefit design, you're either copying rules per member or entangling enrollment with plan data. After the split, `Plan` is the reusable benefit design and `Policy` is the member's enrollment in it. Simple, but it unlocks a lot.

**A wall of edge cases the AI didn't think to guard.** After the happy path passed, I pushed for an adversarial pass: submit the same dispute twice, pay a partially denied claim, overturn a line without re-checking if it's still a duplicate. Each produced a quiet wrong answer — a 500 where a 409 belongs, a line paid twice. None were domain-model problems, just guards the implementation skipped. I named them one at a time; the initiative to look was mine.

**Concurrency re-read the wrong state.** The member-row lock was implemented correctly for adjudication but missed that the same principle applies everywhere a mutation checks preconditions. Two concurrent calls would each pass the precondition check before acquiring the lock, then both proceed. I pushed for the rule: read the guard *inside* the lock, not before it.

**Overlapping policy windows weren't enforced.** The per-line resolver assumes at most one active policy per date — that's what makes resolution unambiguous. But nothing stopped the API from creating two overlapping enrollments. I pushed to reject that at the write boundary and to make the resolver fail loudly if it ever sees more than one active policy.
