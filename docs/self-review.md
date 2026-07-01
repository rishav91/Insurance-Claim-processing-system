# Self-Review

> An honest assessment of what I built: what I'm pleased with, where the edges
> are rough, and what I would tackle first with more time. Written after Phase 7,
> before submission.

---

## What I think is strong

### The adjudication pipeline is a genuine domain model, not CRUD

The engine (`adjudicateLine`, `adjudicateClaim`) has no I/O and no database awareness. It
takes a snapshot of facts — rule, accumulators, override flags — and returns a decision
with a money breakdown and ordered reason codes. Every behavior spec in the test suite
exercises this function directly and encodes a domain rule referenced by section number in
`domain-model.md`. The graded part of the system is independently testable, readable, and
PHI-free by construction.

### The accumulator is a ledger, not a mutable counter

Storing one `AccumulatorEntry` per finalized line — and computing `benefitUsed` as
`SUM(active entries)` — was the right call. Dispute reversal becomes a single `void`
rather than inverse arithmetic that can drift. An audit trail of every limit decision is a
natural consequence, not extra work. The data model and the domain model agree on what an
accumulator *is*.

### Claim status is unrepresentable if inconsistent

`deriveClaimStatus(lineStates[])` is a pure total function with a documented precedence
table. It is never called with a stored value; it is recomputed from the lines on every
read. This means partial approvals (some lines approved, some denied) fall out of the
model correctly without special-casing, and a claim can never be `approved` while one of
its lines is `denied`. The "5 items, 3 covered, 1 denied, 1 under review" scenario the
prompt describes is not a special case — it is just the precedence table returning
`under_review`.

### Single reconciliation path for disputes and manual-review

Both `resolveDispute` (overturn) and `reviewLine` (approve) go through the same core:
void the old ledger entry → re-run `adjudicateLine` with the override → write a new entry
→ re-derive claim status → append the event. There is one code path for "change a line's
outcome," which means the money math can't diverge between the two flows.

### Concurrency is an honest story, not hand-waved

I chose a concrete serialization strategy (member-row version bump inside the transaction,
SQLite single-writer, Postgres `FOR UPDATE` documented as the portable upgrade) and wrote
a test that proves the invariant. I also wrote an honest note about what the test actually
proves on SQLite vs Postgres: the invariant holds, but the row-lock path is the
portability seam, not the local mechanism. I'd rather document the seam than imply the
test proves more than it does.

### Coverage resolved per line by date of service, not asserted by the submitter

This was a design fix that surfaced during review: an earlier draft used `findFirst` by
member and would have returned an arbitrary enrollment for a multi-policy member, or
silently applied the wrong plan for a claim straddling a renewal. The current design
resolves each line independently against the policy whose effective window contains that
line's `serviceDate`. The fix is small in code but large in correctness.

### Coverage rules are data, not code — an operational win with an OCP story

Changing a plan's copay, coinsurance rate, annual limit, or exclusion flag is a database
row edit: no redeploy, no app restart, live at the next submission. The adjudication
engine never hardcodes a benefit value — it interprets whatever `CoverageRule` rows
say. This is the Open/Closed Principle made concrete: the engine is closed to
modification and open to extension through data. It also makes the entire rule surface
testable without any mocking or config stubbing.

The honest limitation: `CoverageRule` rows are mutable with no version history, so a
rule edited after adjudication silently affects any re-run of that line (dispute
overturn, review approval). Real payer systems treat rule changes as prospective-only
and replay historical adjudication against the snapshot in force at the date of service.
The financial breakdown stored on `LineItem` at first adjudication is frozen and correct;
a re-adjudication path reading the current rule is where the gap lives.

---

## What's rough or limited

### Resolution is order-dependent across claims — disputes and manual-review approval

Both dispute overturn (`resolveDispute`) and manual-review approval (`reviewLine`) share
the same `rerunLineInTx` reconciliation path, which reloads the *current* accumulator —
not the state at original adjudication time. An overturn or a late approval can push
`benefitUsed` past the annual cap if the cap was consumed by later claims in the
interim. I've made this visible for the dispute path: there is a behavior spec that
demonstrates order-dependence and a documented "WHAT TO OBSERVE" note in the demo. The
same limitation applies to manual-review approval but is not separately spec'd.

A less obvious corollary: when a single claim has *multiple* pended lines competing for
the same annual limit, the original `adjudicateClaim` fold processes them in
deterministic `(serviceDate, id)` order — but once pended, each is resolved by an
independent `reviewLine` call in no guaranteed sequence. Two pended lines sharing a cap
will split it based on reviewer call order, not service-date order. Neither path
cascades re-adjudication, and there's no report of "this resolution left the accumulator
inconsistent with claim X."

### One active dispute per line, no appeal history

`Dispute.lineItemId` has a unique constraint. A second dispute attempt returns 409. One
cycle covers the full reconciliation path, but real adjudication systems track multi-level
appeals. The fix is architectural: drop the unique constraint, add a "no open dispute"
guard, and the model already handles the rest (the ledger's void-then-write pattern works
for any number of overturns).

### SQLite for portability — PostgreSQL for the money path, document store for rules

SQLite is a deliberate portability choice: a reviewer clones and runs with no external
infra. `connection_limit=1` means two concurrent claims for *different* members also
serialize, even though they share no resources. Fine for a local demo; wrong for
production.

A real money-path system needs **PostgreSQL**: row-level `SELECT … FOR UPDATE` locking
(the documented portability seam — the member-row version bump is already the right
target), connection pooling, and point-in-time recovery for the financial ledger. The
concurrency design is already written against this target; SQLite is the approximation.

For the **CoverageRule configuration** layer specifically — plan definitions, benefit
schedules, exclusion flags, review flags — a document store (e.g. MongoDB) is worth
considering: rules are read-heavy, schema-flexible (a new benefit attribute is a field
addition, not a migration), and do not participate in the financial transaction. Keeping
rule config in a separate, read-optimised store avoids mixing it with the ACID-critical
ledger and claim tables, and lets ops teams update benefit configurations through a
different operational path than schema migrations. The adjudication engine wouldn't
change at all — it only consumes the resolved `CoverageRule` struct, not the store it
came from.

### No cross-claim cascade on denial changes

If a duplicate detection overturns — the duplicate denial on claim B was wrong, and the
denial is lifted — claim A, whose line is what triggered the duplicate flag, may now need
reassessment. The system doesn't model this dependency and doesn't cascade. The limitation
is documented in `decisions.md §7`.

### `prisma db push` instead of migration history

For a greenfield take-home with no production data to evolve, a migration history would be
ceremony. The schema file + `db push` is reproducible from a clean database, which is what
the README setup flow needs. A production system would use `prisma migrate dev` from day
one.

### Modular core, monolithic shell — not yet microservice-ready

The domain core (`src/domain/`) is fully extractable today: pure functions, no I/O, zero
Prisma awareness. It could become a standalone "Adjudication Engine" service called over
RPC with no internal changes. The orchestration layer is a different story. `services/claims.ts`
is a single ~940-line file spanning claim lifecycle, dispute resolution, manual-review, and
accumulator reporting — no bounded module separation. More fundamentally, the concurrency
model is single-database-coupled by design: the member-row lock spans claim, line-item,
accumulator, and event writes inside one Prisma transaction. Pulling the accumulator or
dispute subsystem into a separate service would break that atomic "lock → sum → decide →
write" invariant without a saga/outbox replacement. The honest label is **modular core,
monolithic shell** — genuinely clean internal seams, but the orchestration boundaries are
not yet cut along service lines. A real microservice split would require bounded contexts
(Eligibility/Enrollment, Claims Intake & Adjudication, Accumulator/Ledger, Payment/
Disbursement, Appeals) each with their own persistence, and a distributed consistency
strategy to replace the single-transaction lock.

### Real-system gaps worth naming

**EDI/X12 absent.** Real claim intake flows over the 837 transaction set via a
clearinghouse; the system's REST/JSON interface is a deliberate simplification. A real
payer integration would need X12 parsing at the ingestion boundary and would emit an 835
remittance on payment.

**CoverageRule versioning.** As noted in the OCP section above, `CoverageRule` rows
are mutable. A rule change post-adjudication silently affects any re-run. Production
systems require prospective-only benefit changes with effective-dated rule snapshots so
historical re-adjudication always sees the rule as it stood at the time of service.

**No retroactive policy termination or recoupment.** A policy cancelled after claims
were already paid against it is a real payer event (overpayment recovery / recoupment
workflow). The current model has no clawback path — `paid` is terminal with no
adjustment records. This is adjacent to the COB cut but a separate operational gap.

**No separation of member-facing vs. admin-facing API surfaces.** All endpoints sit
under a single flat `/v1/*` prefix with no authz boundary between what a member can
invoke and what a reviewer/admin can. See `decisions.md §6`.

---

## What I would tackle first with more time

**1. Cross-claim re-adjudication (or at least a consistency report)**
The order-dependence limitation is real and materially affects system correctness in the
multi-claim case. The right first step is a report: after any resolution, flag if
`benefitUsed` now exceeds the cap, and which other claims are affected.

**2. Out-of-pocket maximum as a second accumulator dimension**
It is one more `AccumulatorEntry` type, one more pipeline step, and one more
`benefitUsedByServiceType` key. The architecture already supports it; the delta would
be a few dozen lines and one more behavior spec. This would meaningfully strengthen the
"multiple interacting accumulators" story.

**3. Full rule trace alongside `reasons[]`**
The current `reasons[]` contains only money-affecting steps. A full trace (every gate
evaluated, pass or no-op) makes the audit story stronger and is a natural extension of
the existing architecture — each gate already knows whether it fired.

**4. Override taxonomy — all six types are actually wired**
A note for accuracy: all six override types in the taxonomy (`FORCE_COVERED`,
`MARK_ELIGIBLE`, `ALLOW_DUPLICATE`, `WAIVE_DEDUCTIBLE`, `WAIVE_LIMIT`,
`OVERRIDE_ALLOWED_AMOUNT`) are implemented and tested — earlier drafts of this document
understated the coverage. The real next step is ensuring each is exercisable through the
HTTP layer with validation (the Zod schema already accepts them; the gap is ergonomics
and documentation, not implementation).

**5. `procedureCode → serviceType` crosswalk**
The current model collapses this to a validated `serviceType` string in the payload. A
real system maps CPT/HCPCS codes → benefit categories via a lookup table. The adjudication
engine would be unchanged; only the orchestration's "gather facts" step would grow a
crosswalk lookup before calling the engine.

**6. Structural design patterns — where I would invest with more time**
Three specific improvements I would make before the codebase grew further:

- *Chain of Responsibility for the gate pipeline.* `adjudicateLine` is currently a
  single function with nine sequential early-return gates. Making each gate a discrete
  handler object (composable, reorderable without touching the function body) would let
  gate sets be configured per plan type and individually unit-tested in isolation.
- *Strategy per override type.* The seven `has("TYPE")` branches in `adjudicateLine`
  and `computeCostShare` are flat conditionals. A strategy object per override type
  would make each bypass independently extensible and testable without editing the
  pipeline body — important once the taxonomy grows.
- *Complete the Repository pattern.* `db/repositories.ts` abstracts accumulator ledger
  ops but `services/claims.ts` calls `prisma.*` directly for everything else (claims,
  disputes, policies). A consistent repository layer per aggregate would make a future
  DB swap a boundary change rather than a grep-and-replace across the service file.

---

## Where I steered the AI vs. where I accepted

The AI did the structural work well — the ledger model, the pure engine boundary, the TDD rhythm — and I accepted those without pushback. The steers below are where I caught something that looked right on the surface but would have quietly misbehaved in a real
system.

**Plan and Policy were the same thing.**
The first draft put coverage rules, enrollment dates, and the deductible all on a single `Policy` entity. It worked as long as you only ever thought about one member at a time.
I pushed back because the moment two members share the same benefit design, a merged entity forces you to either copy the rules per member or entangle enrollment data with plan data.
After the split, a `Plan` is the reusable benefit design shared across members, and a `Policy` is a member's enrollment in it over a time window. The question "what does the plan pay?" and the question "is this member covered today?" stopped being the same question.

**Coverage was being picked by the submitter, not resolved by date.**
The early implementation had the orchestration do a `findFirst` lookup by member to get the active policy. That single lookup returns one enrollment — but which one? For a member who renewed mid-year or switched plans, it could return an arbitrary record. Worse, a claimant could effectively choose the more favorable coverage by timing their submission.
I caught this while thinking through the multi-policy scenario and pushed for a different contract: the submit payload carries no `policyId` at all. Instead, each line resolves the policy whose effective window contains *its own* service date, independently. A claim that straddles a renewal adjudicates each line under the plan that was actually in force for that line. The right answer is derived, not asserted.

**A wall of edge cases the AI didn't think to guard.**
After the core flows were working and the happy path passed, I pushed for a focused adversarial pass: what happens if someone submits the same dispute twice? What if a claim that was partially denied is sent to pay? What if an overturn re-adjudicates a line without re-checking whether it's still a duplicate? Each of these produced a quiet wrong answer — a 500 where a 409 belongs, a line paid twice, an overturn that launders a duplicate through. None of them were domain-model problems; they were guards the implementation skipped because the happy path didn't require them. I named them one at a time and the AI fixed them one at a time, but the initiative to look was mine.

**Concurrency re-read the wrong state.**
The concurrency design — lock the member row, sum the ledger inside the transaction — was accepted and implemented correctly for the adjudication path. What it missed was that the same principle applies everywhere a mutation checks preconditions: a dispute resolution that reads `dispute.status === "open"` before acquiring the lock, a payment that reads line states before the member row is locked. Two concurrent calls on the same resource would each pass the precondition check, then both proceed. I caught this and pushed for
the rule to be stated explicitly: read the guard *inside* the lock, not before it. Every mutating path now re-reads its transition check after the lock is held.

**The policy window invariant wasn't enforced anywhere.**
The per-line resolver assumed at most one policy is active on any given date — that's what makes the resolution unambiguous. But nothing was stopping the API from creating two overlapping enrollments for the same member, which would have made the resolver silently pick one and discard the other. I pushed to make the invariant a hard enforcement at the write boundary: creating a policy that overlaps an existing window is rejected outright. The resolver was also changed to fail loud if it ever saw more than one active policy, converting a silent arbitrary-pick into a visible error.
