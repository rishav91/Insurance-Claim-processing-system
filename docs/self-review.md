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

---

## What's rough or limited

### Dispute resolution is order-dependent across claims

When a line is overturned, the engine re-runs against the *current* accumulator — which
other claims may have moved since the original adjudication. An overturn can push
`benefitUsed` past the annual cap if the cap was consumed by later claims. I've made this
visible: there is a behavior spec that demonstrates the order-dependence and a documented
"WHAT TO OBSERVE" note in the demo. But the system does not cascade re-adjudication, and
there's no report of "this resolution left the accumulator inconsistent with claim X."

### One active dispute per line, no appeal history

`Dispute.lineItemId` has a unique constraint. A second dispute attempt returns 409. One
cycle covers the full reconciliation path, but real adjudication systems track multi-level
appeals. The fix is architectural: drop the unique constraint, add a "no open dispute"
guard, and the model already handles the rest (the ledger's void-then-write pattern works
for any number of overturns).

### SQLite over-serializes across members

`connection_limit=1` means two concurrent claims for *different* members also serialize,
even though they don't share any resources. This is fine for a local demo and the
test suite, but a production deployment would use Postgres with per-row `FOR UPDATE`
and a connection pool so cross-member parallelism is restored. The design accounts for
this (the version-bump is explicitly the Postgres portability seam), but it's worth
naming.

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

**4. The remaining override types**
`WAIVE_DEDUCTIBLE`, `WAIVE_LIMIT`, and `OVERRIDE_ALLOWED_AMOUNT` are implemented. The
full taxonomy from `domain-model.md` includes `MARK_ELIGIBLE` and `SKIP_DUPLICATE_CHECK`.
Each follows the identical pattern: a boolean flag that bypasses its corresponding gate.
The domain model is already correct; the implementation is one more branch per gate.

**5. `procedureCode → serviceType` crosswalk**
The current model collapses this to a validated `serviceType` string in the payload. A
real system maps CPT/HCPCS codes → benefit categories via a lookup table. The adjudication
engine would be unchanged; only the orchestration's "gather facts" step would grow a
crosswalk lookup before calling the engine.
