# Decisions & Trade-offs

> What I built, what I deliberately didn't, and the assumptions behind each. The
> "why" matters more than the "what" — every cut below is a choice with a reason,
> not an oversight. Entities/state machines live in `domain-model.md`; domain
> vocabulary in `domain-research.md`.

## 1. How I approached it

I treated **domain research as part of the work, not a preamble**: I wrote
`domain-research.md` first, then designed the model against it, then ran the design
through a structured self-interrogation (scope grilling) and a critical subagent
review before writing any code. The model doc carries the scars of that process —
several sections exist specifically because the review or the grilling found a hole.

The guiding principle for scope: **three flows done well beats ten done poorly.** The
three are *submit → adjudicate → dispute*, plus the manual-review path the prompt
explicitly names.

## 2. Stack & interface

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | **TypeScript / Node** | Daily-driver stack → time goes to the domain, not the tooling. |
| Interface | **REST API** | Evaluators can `curl` the flows; demonstrates lifecycle + disputes better than a CLI. |
| Persistence | **SQLite via Prisma** | Typed models double as schema docs; zero infra for a take-home. Also gives a concrete single-writer concurrency story (see §5). |
| Tests | **Vitest, behavior-first** | Specs encode domain rules (`domain-model.md` §7), written before/with code so git history shows TDD. |

Persistence is real (not in-memory) specifically so the **accumulator** — the
stateful heart of the domain — is exercised across requests, not faked.

**What a production system would use instead.** SQLite is chosen for portability — a
reviewer can clone and run with no external infra. A real money-path system would use
**PostgreSQL**: full ACID guarantees under concurrent load, row-level `SELECT … FOR
UPDATE` locking (the documented Postgres portability seam in §5), connection pooling
(PgBouncer), and point-in-time recovery for the financial ledger. The concurrency design
in §5 is already written against this target; SQLite is only the local approximation.
For the **CoverageRule configuration** layer — plan definitions, benefit schedules,
exclusion flags — a document store (e.g. MongoDB) is a reasonable alternative: rules are
read-heavy, schema-flexible, and do not participate in the financial transaction. A
separate read-optimised store for rule config would avoid mixing the rule-lookup concern
with the ACID-critical ledger and claim tables.

## 3. The decisions that define the domain model

These are the choices a reviewer should interrogate me on.

### Coverage rules are **data interpreted by an engine**, not code
A `CoverageRule` is a row (`serviceType`, `excluded`, fee schedule, copay/coinsurance,
annual limit, review flag). A new benefit is a row, not a deploy — updating a plan's
copay, coinsurance rate, annual limit, or exclusion flag requires **no redeploy and no
app restart**; the change is live at the next claim submission. This is the centerpiece
decision and its direct operational consequence. It is also the concrete application of
the **Open/Closed Principle**: the adjudication engine (closed to modification) is
extended through data (open via new or changed rows), never through code changes. The
alternative (rules as code/DSL) was rejected as over-engineering for the scope; a data
table covers every rule we need and stays testable without mocking config.

**Limitation — prospective-only rule changes not enforced.** `CoverageRule` rows are
mutable with no effective-dating or version history on the rule itself (only `Policy`
has effective windows). If a rule is edited *after* a claim is already adjudicated, a
re-run of that line (via dispute overturn or manual-review approval) will silently apply
the new rule rather than the rule as it stood at the time of service. The stored
financial breakdown on `LineItem` (amounts, reasons) is frozen at the time of original
adjudication — so the initial outcome is correct — but a re-adjudication reads the live
`CoverageRule`. Real payer systems enforce prospective-only changes: rule edits carry a
future effective date and historical adjudication always replays against the snapshot in
force at the date of service. The fix is effective-dating on `CoverageRule` itself, or
snapshotting the rule's key parameters onto the claim line at first adjudication.

### Plan and Policy are **separate** entities
A **Plan** is the reusable benefit design (its coverage rules + deductible/limits); a
**Policy** is a member's enrollment in a Plan over an effective window. Coverage rules
belong to the Plan, so they're shared across members rather than copied per person, and
"is the member covered on this date" (Policy) is cleanly distinct from "what does the
plan pay" (Plan). An earlier draft conflated the two onto `Policy`; the split was made
after a domain pass.

### Coverage is resolved **per line, by date of service** — not asserted on submit
The submit payload carries `memberId`/`providerId` but **no `policyId`**: which
enrollment applies is *derived* from the service date, not chosen by the submitter (a
claimant must not be able to pick the more favorable coverage). Each line resolves the
policy whose effective window contains *its own* `serviceDate`, so a claim that straddles
a renewal adjudicates each line under the plan that was actually in force — rules and the
annual deductible both come from that line's plan (the engine's deductible is therefore
per-line). An earlier `findFirst`-by-member picked an arbitrary enrollment; that bug is
what surfaced this. A line whose date falls in **no** window is `COVERAGE_INACTIVE`
(classified by the member's most recent enrollment so a *known* service denies on
eligibility, not as an unknown service); a member with **zero** policies is a 404.

### Single active coverage — **non-overlapping** policy windows per member (invariant)
A member holds at most one policy active on any given date, so per-line resolution is
unambiguous. Enforced at the policy **write boundary** (`createPolicy` rejects an
overlapping window, inclusive boundaries) since SQLite can't express a range-exclusion
constraint; on Postgres this is an `EXCLUDE USING gist` constraint (same portability seam
as `SELECT … FOR UPDATE`). The resolver also fails loud if it ever sees >1 active policy,
converting a silent arbitrary-pick into an error. **Cut: coordination of benefits (COB).**
Real members can hold simultaneous primary+secondary coverage with a payment order; that's
excluded here for the same reason as subscriber/dependent and group sponsor — enrollment
complexity without new adjudication insight. *Limitation:* within one plan year a mid-year
policy change shares the deductible accumulator (no deductible-credit reset), since the
ledger is keyed by year, not policy.

### Usage is tracked as a **ledger**, not a mutable counter
Each finalized line writes one `AccumulatorEntry`; `deductibleMet` / `benefitUsed` are
the **sum of active (non-voided) entries**. Chosen over a single mutable total because:
(a) dispute reversal becomes *void the entry* instead of reverse-then-reapply
arithmetic that can drift; (b) every limit decision is auditable (which line consumed
what). Cost is a `SUM` on read — negligible at this scale. The pure engine is unchanged:
it still reads a totals snapshot and emits a delta; only the persistence boundary differs.

### An append-only **event log** records every transition
`Event` rows (`SUBMITTED`, `ADJUDICATED`, `PENDED`, `DISPUTED`, `RESOLVED`, `PAID`) make
the lifecycle observable over time, give disputes a retroactive-change audit trail, and
seed a real PHI access/change audit. `actor` is a plain label since auth is out of scope.

### Adjudication is **per line item**; claim status is **derived**
`deriveClaimStatus(lineStates[])` is a total pure function (precedence table in
`domain-model.md` §4). Claim status is never set directly, so partial approvals fall
out naturally and inconsistent states are unrepresentable. This directly answers the
prompt's "5 line items, 3 covered, 1 denied, 1 review" question.

### `partially_approved` is reserved **only** for annual-limit overflow
A line where the member owes a deductible/copay is still **`approved`** — cost-sharing
is not partial approval. `partially_approved` means exactly one thing: the line was
paid up to the remaining limit and the excess denied. Keeping the status meaningful
was a deliberate modeling choice that the subagent review confirmed avoids confusion.

### One engine, one resolution path
Submission, manual-review resolution, and dispute overturn all flow through the same
`adjudicateLine` function and the same reconciliation routine — *void the old ledger
entry, re-run the engine, write a new entry* (`domain-model.md` §6). Single source of
truth for money math and ledger bookkeeping; no parallel code paths to drift apart.

### Explanations are a **byproduct of execution**
Each pipeline step emits its reason as a side effect, so the ordered `reasons[]` can
never disagree with what the engine actually did. I chose this over a full rule-trace
(every pass/no-op step) because the "explain WHY it was denied/reduced" signal is fully
served by the money-affecting steps; the trace is a cheap later add (architecture is
ready for it).

### The adjudication engine takes **no PHI**
`adjudicateLine` receives only `serviceType`, dates, amounts, and accumulators — never
`name`, `dateOfBirth`, or `diagnosisCode`. So the entire rules engine, its logs, and
its explanations are PHI-free by construction. This was the cheapest high-signal way to
honor the prompt's "sensitive health data" framing without building access control.

## 4. Assumptions about the domain

Where the prompt is silent, I made a call and recorded it:

| Topic | Assumption | Rationale |
|---|---|---|
| **Limit overflow** | Pay up to the remaining limit, deny the excess → `partially_approved`. | Prompt is silent; this matches how real benefit maximums behave and best showcases partial approval. |
| **Plan year** | Governed by **date of service**, not submission date. | Standard insurance behavior; keeps eligibility and accumulators on one clock. A Dec-2025 service submitted Jan-2026 counts against 2025. |
| **Cost-share "neither"** | A rule with neither copay nor coinsurance = `coinsurance 0` → 100% coverage after deductible. | Preventive-care benefits are real and need a defined meaning; "neither" shouldn't be undefined. |
| **`serviceType` ownership** | A **payer-controlled benefit category**, validated against the policy; not a trusted member assertion. | Mirrors reality (payer maps procedure codes → categories) while staying simple. |
| **Limit-exhausted vs hard denial** | A limit-exhausted line still applies its **deductible** delta; a hard denial (excluded/duplicate/invalid) touches **no** money or accumulators. | A limit-hit service is still *covered* — the member's deductible-eligible spend is real. A not-covered service never enters the money model. |
| **Duplicate** | Same `(member, serviceType, serviceDate, provider)` against any prior **non-denied** line. | Simple, deterministic, catches the realistic resubmission case. |
| **Allowed amount** | `min(billed, feeSchedule)` if the rule has a schedule, else `billed`. | Preserves the `billed ≠ allowed` distinction cheaply without modeling provider contracts. |
| **Reference data** | Plans (+rules), policies, members, providers are **seeded**, not managed via the API. | The prompt lists account/policy management as out of scope. |
| **Adjudication timing** | Two-step: `POST /claims` persists `submitted`; `POST /claims/:id/adjudicate` runs the engine. | Makes the `submitted → under_review → …` lifecycle explicit and demonstrable, matching the prompt's named flow. |
| **Payment** | A `pay` action (`POST /claims/:id/pay`) sets `paidAmountCents`/`paidAt` fields and moves lines to `paid`. | Demonstrates the terminal lifecycle state; a separate `Payment` entity is unnecessary without clawback. |
| **Money** | Integer **cents** everywhere; all arithmetic clamps to ≥ 0. | Avoids float drift; clamping prevents negative payable (copay > allowed, etc.). |

## 5. Concurrency

I did **not** assume "single-threaded and hope." Two claims for the same member
adjudicated concurrently could each read the same ledger sum and both approve against
the full remaining limit, overspending it. Decision: **the member/policy row is the
serialization point** — a claim is adjudicated inside one transaction that locks that
row before summing the ledger, so the sum→decide→insert sequence is atomic. SQLite's
single-writer model makes this concrete locally; the Postgres equivalent is
`SELECT … FOR UPDATE` on the member/policy row. Stated as an invariant with a test.

**How it's made concrete (Phase 3):** `adjudicateClaim` runs in one Prisma
interactive transaction that first bumps `Member.version` (the write that takes the
row lock) *before* summing the ledger, and the SQLite client is pinned to
`connection_limit=1` so two concurrent claims for a member serialize on the single
writer rather than racing the same sum→decide→insert. The spec *concurrent claims
for one member do not overspend a shared limit* fails without this. Trade-off: a
single connection over-serializes (different members can't proceed in parallel
locally) — acceptable for SQLite; the Postgres refinement is the per-row `FOR UPDATE`.

> **Honest note on what the test proves.** On SQLite the `connection_limit=1` pin **is**
> the serializer — an interactive transaction holds the one connection for its whole
> duration, so a second transaction can't even `BEGIN` until the first commits. The
> `Member.version` bump is therefore the **portability seam** (it becomes the literal
> `SELECT … FOR UPDATE` target on Postgres, where a pool > 1 lets *different* members
> proceed in parallel while same-member claims serialize on that row), not the
> load-bearing lock locally. The passing concurrency spec proves the **invariant holds**,
> not that the row-lock path is exercised on SQLite. (`busy_timeout`/WAL are set on the
> running server as defense-in-depth against any residual `SQLITE_BUSY`.)

**The same principle — read state under the lock, not before it — applies to every mutating path.** `resolveDispute` and `reviewLine` re-read their transition guards (`dispute.status === "open"`, `lineItem.status === "pended"`) *inside* the locked transaction so two concurrent resolves of the same dispute can't both see `open`, both pass, and emit two `RESOLVED` events. `adjudicateClaim` re-reads line statuses inside the transaction after the lock so a second concurrent call on the same claim id (which would otherwise re-run the engine and write duplicate `AccumulatorEntry` rows against an already-moved accumulator) sees the non-`submitted` lines and 409s. `payClaim` takes the same member lock and re-reads line states inside the transaction, preventing two concurrent disbursements from each writing a `PAID` event. The loser in every case is the one whose state re-read — under the lock — shows the transition already happened; it returns 409. `resolveDispute` is keyed on the **dispute id** the endpoint exposes (not the line id), so the HTTP handler needs no dispute→line translation read. Specs: *serializes two concurrent adjudications / payments / resolves / reviews on the same resource — one wins, one 409s*.

**Idempotency keys — deliberate cut.** The system uses 409 semantics (reject duplicate)
rather than true idempotency (idempotency-key header + cached-response replay):
- **Adjudicate retry:** `POST /claims/:id/adjudicate` already returns 409 on re-call;
  the caller retries by doing `GET /claims/:id` instead of re-triggering.
- **Claim re-submission:** submitting the same claim twice creates a second claim row, but
  adjudication of the second claim will detect its lines as `DUPLICATE` against the first
  (same member + provider + service + date), so the over-submit is caught at adjudication.
- **Pay retry:** `payClaim` now re-checks under the lock and 409s if already paid.
- True idempotency (a separate idempotency-key table + response cache + header convention)
  is a non-trivial cross-cutting concern that adds no adjudication depth. The
  operator-driven insurance workflow is low-frequency; the 409-and-GET pattern covers the
  realistic retry cases. Not built.

**Schema management:** I use `prisma db push` (schema is the source of truth) rather
than a migration history. For a greenfield take-home with no production data to
evolve, migrations would be ceremony; the schema file + `db push` is reproducible
from a clean DB, which is what the README flow needs.

## 6. What I deliberately did NOT build (calibrated cuts)

Each of these is a conscious trade-off; none is an accident.

| Cut | Why it's safe to cut | What it would take to add |
|---|---|---|
| **Subscriber vs dependent** | One member per policy; covering multiple people on one policy adds enrollment complexity without new adjudication insight. | A member↔policy join with a role + per-member accumulators. |
| **Group / employer sponsor** | Adjacent enrollment hierarchy; irrelevant to adjudication depth. | A Group entity above Policy. |
| **`Payment` entity** | `paid` is terminal with no clawback, so claim-level `paidAmountCents`/`paidAt` fields suffice. | A disbursement/remittance ledger + post-payment adjustments. |
| **OOP maximum** | One more accumulator dimension; the deductible + per-service limit already demonstrate "track usage against limits." | One more `AccumulatorEntry` dimension + one pipeline step. |
| **Visit / frequency limits** | Same *shape* as the dollar limit (count vs cents); adds surface without new insight. | A count-based accumulator + step. |
| **Waiting periods, pre-authorization** | Adjacent benefit rules; don't add modeling depth beyond what eligibility/exclusion already show. | Extra rule fields + pipeline gates. |
| **In/out-of-network rate negotiation** | Would turn `provider` into a rate source; the fee schedule already gives `billed ≠ allowed`. | Provider-contract entity + network status input. |
| **Medical-necessity / real ICD-CPT code sets** | Requires code databases and crosswalks; not the modeling signal being tested. | Code tables + `procedureCode → serviceType` crosswalk + necessity rules. |
| **`procedureCode → serviceType` crosswalk** | Collapsed to a direct, validated `serviceType` field. | A lookup table + validation. |
| **`deductibleExempt` (first-dollar coverage)** | Preventive 100%-no-deductible is a flag away; the "neither = 0%" rule covers full coverage *after* deductible. | One boolean on the rule + a skip in step 7. |
| **Timely-filing limits** | Rejecting late-filed claims is a date check unrelated to adjudication depth. | A submission-date vs service-date guard. |
| **Disputes on `paid` lines** | Clawback / supplemental payment needs a money-ledger we don't model; disputes target denials/partials (all pre-payment), so the common case is covered. | A disbursement ledger + adjustment records. |
| **Re-dispute (multiple appeals per line)** | **One dispute per line** (`Dispute.lineItemId` is unique). A second dispute is a clean `409`, not a 500. One appeal cycle exercises the full reconciliation path; multi-level appeals add an appeal-history entity without new adjudication depth. | Drop the unique constraint → a `Dispute[]` history per line (mirrors the ledger's "one active + audit copies" model) + gate on "no *open* dispute." |
| **Cross-claim cascade re-adjudication** | See §7 — accepted limitation, not a missing feature. | Dependency tracking across claims + re-run orchestration. |
| **Override types beyond 3** | The full taxonomy is *defined* in the model; `WAIVE_LIMIT`/`MARK_ELIGIBLE`/`WAIVE_DEDUCTIBLE` prove both shapes (boolean + parameterized). | The remaining gates follow the identical pattern. |
| **Client/admin API boundary** | All 10 endpoints sit flat under `/v1/*` with no separation between member-facing (submit, get, list, dispute, accumulators) and reviewer/admin-facing (adjudicate, pay, review pended lines, resolve disputes) surfaces. Auth is out of scope, so there is no seam for different authz scopes, rate limits, or independent versioning lifecycles. | Route prefixes `/v1/member/…` vs `/v1/internal/…` + an auth middleware per surface. |
| **Auth / registration / multi-tenant** | Explicitly out of scope per the prompt. | — |

## 7. Known limitation I want to flag honestly

**Dispute resolution is consistent for the resolved line, but not across interleaving
claims.** Reverse-then-reapply recomputes a line's delta against the accumulator's
*current* value, which other claims may have moved in the meantime. So an overturn can
push `benefitUsed` past the annual cap, or a from-scratch time-ordered re-run could have
awarded the remaining dollars to a different claim. This is **order-dependent and
accepted**: a dispute resolves *one* line against present state; we do not cascade
re-adjudicate other claims, and an override is an intentional exception that may exceed a
cap. There's a behavior spec that *demonstrates* this order-dependence so it's visible in
the test suite, not hidden. This is the honest boundary of the consistency model.

## 8. If I had more time (in priority order)

1. **Cross-claim re-adjudication** (or at least a flag/report when a resolution leaves
   the accumulator inconsistent with a later claim).
2. **OOP maximum** as a second accumulator dimension — cheap, strengthens the
   "multiple interacting accumulators" story.
3. **Full rule trace** alongside `reasons[]` for audit (the architecture already
   supports it).
4. The remaining **override types** + a `procedureCode → serviceType` crosswalk.
5. An **audit log** of who-viewed/changed PHI to round out the sensitive-data story.
