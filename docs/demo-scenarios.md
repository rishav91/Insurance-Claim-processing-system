# Demo Scenarios

> Realistic scenario sets for evaluating the claims processing system end-to-end.
> Each set is a self-contained story: the seed data it needs, the call sequence,
> and what to observe. Sets are ordered from simplest to most complex. Thread-safety
> scenarios appear last and are the most important to run as a group.
>
> All calls hit the Fastify REST API. Seed data (members, plans, policies, providers)
> is assumed pre-loaded; see `Phase 6` in `roadmap.md` for the seed script.

---

## Set 1 — Core money model (single claim, single line)

These four scenarios isolate the four cost-share configurations a CoverageRule can
express. Each is a single claim with a single line against a member with a zero
deductible so the cost-share math is unobstructed.

### 1-A  Fixed copay — office visit

**Setup:** plan with an `OFFICE_VISIT` rule: copay $30, no coinsurance, no annual limit.

**Steps:**
1. `POST /v1/claims` — submit a single `OFFICE_VISIT` line, billed $200.
2. `POST /v1/claims/:id/adjudicate`

**Observe:** `status = approved`; `adjudication.payableCents = 17000` (billed 200 − copay
30 = 170); `memberResponsibilityCents = 3000`; `reasons` contains `COPAY_APPLIED`.
`payable + memberResponsibility == allowed` — the money invariant.

---

### 1-B  Coinsurance — physical therapy

**Setup:** plan with a `PT` rule: 20% coinsurance, $1000 annual deductible (met = $0),
no annual limit.

**Steps:**
1. `POST /v1/claims` — submit a `PT` line, billed $500.
2. `POST /v1/claims/:id/adjudicate`

**Observe:** deductible consumes the full $500 → `payableCents = 0`, `status = approved`
(member owes deductible, but the line is still *covered*). Confirms that a line where the
member owes only a deductible is `approved`, not `partially_approved`.

**Variant (deductible already met = $1000):** same call; now `deductibleApplied = 0`,
`coinsuranceMember = 100` (20% of 500), `payable = 400`, `status = approved`.

---

### 1-C  No cost share — preventive care

**Setup:** plan with a `PREVENTIVE` rule: no copay, no coinsurance (the "100% after
deductible" case). Zero deductible.

**Steps:**
1. Submit a `PREVENTIVE` line, billed $150.
2. Adjudicate.

**Observe:** `payableCents = 15000`, `memberResponsibilityCents = 0`, `status = approved`,
`reasons` does not contain any cost-share code. Demonstrates that "neither copay nor
coinsurance" is a valid, defined configuration — not a gap.

---

### 1-D  Fee schedule reduction

**Setup:** `PT` rule with `allowedAmountCents = 30000` (the contracted rate is $300).
Zero deductible, zero coinsurance.

**Steps:**
1. Submit a `PT` line, billed $500 (provider charges more than the contracted rate).
2. Adjudicate.

**Observe:** `allowedCents = 30000` (not 50000), `payableCents = 30000`, `reasons`
contains `ALLOWED_REDUCED`. The insurer pays the contracted rate; the member is not
responsible for the excess (per our model — network negotiation is a named cut, but the
`billed ≠ allowed` distinction is live).

---

## Set 2 — Accumulator stories (state across claims)

These scenarios demonstrate that the ledger is stateful across requests and that the
engine folds correctly within a single claim. Each requires at least two claims or two
lines.

### 2-A  Deductible depletion across two claims

**Setup:** plan with a `PT` rule, deductible $1000, zero coinsurance, no limit.

**Steps:**
1. Submit + adjudicate Claim 1: `PT`, billed $600. → `deductibleApplied = 600`,
   `payable = 0`.
2. `GET /v1/members/:id/accumulators?planYear=2026` → `deductibleMetCents = 60000`.
3. Submit + adjudicate Claim 2: `PT`, billed $600. → `deductibleApplied = 400`
   (remaining), `payable = 20000` (200 paid, 400 to deductible).

**Observe:** the accumulator persisted from Claim 1 to Claim 2. The deductible was never
double-spent; Claim 2 saw exactly the remainder.

---

### 2-B  Annual limit depletion → partial approval

**Setup:** `PT` rule: 20% coinsurance, $2000 annual limit, zero deductible.

**Steps:**
1. Submit + adjudicate Claim 1: `PT`, billed $1800 → `payable = 144000` (80% of 1800),
   `benefitUsed[PT] = 144000` after adjudication.
2. Submit + adjudicate Claim 2: `PT`, billed $1000. Remaining limit = $2000 − $1440 = $560.
   80% of $1000 = $800. $800 > $560 → `partially_approved`.

**Observe:** `payableCents = 56000`, `reasons` contains `PARTIALLY_PAID` (560) and
`LIMIT_EXHAUSTED` (240). `GET /v1/members/:id/accumulators` shows `benefitUsedByServiceType.PT = 200000`.
The cap was never exceeded.

---

### 2-C  Intra-claim accumulator fold (two lines, one claim)

**Setup:** `PT` rule: zero coinsurance, $2000 annual limit, zero deductible.

**Steps:**
1. Submit a claim with **two** `PT` lines on different dates, each billed $1500.
2. Adjudicate.

**Observe:** lines are processed in `(serviceDate, id)` order. Line 1 consumes the full
$2000 limit → `approved`, `payable = $2000` would overshoot, actually `payable = $1500`
(within limit). Actually: Line 1: billed $1500, limit $2000, payable $1500.
Line 2: billed $1500, remaining limit $500, `partially_approved`, payable $500,
`LIMIT_EXHAUSTED` $1000. Total paid = $2000.

**Observe:** total `payable` across the two lines = $2000, never $3000. The fold inside
one claim enforces the limit as tightly as cross-claim accumulation does.

---

### 2-D  Year-boundary claim (two accumulators, one claim)

**Setup:** member holds a 2025 policy (Jan–Dec 2025) and a 2026 policy (Jan–Dec 2026),
each with a `PT` rule and a $1000 deductible per plan year.

**Steps:**
1. Submit a claim with two `PT` lines: one dated `2025-12-20`, one dated `2026-01-10`.
2. Adjudicate.

**Observe:** the Dec line is adjudicated under the 2025 plan (its deductible); the Jan
line under the 2026 plan (fresh deductible). `GET /v1/members/:id/accumulators?planYear=2025`
and `?planYear=2026` show independent `deductibleMetCents`. The same service-date clock
governs both the plan lookup and the accumulator bucket.

---

## Set 3 — Denial taxonomy

Each scenario isolates one hard-denial gate. Hard denials touch no money and write no
accumulator entry.

### 3-A  Excluded service

**Setup:** plan has `COSMETIC` rule with `excluded = true`.

**Steps:** submit + adjudicate a `COSMETIC` line.

**Observe:** `status = denied`, `reasons` contains `SERVICE_EXCLUDED`, `payable = 0`,
`memberResponsibility = 0`. `GET /v1/members/:id/accumulators` unchanged.

---

### 3-B  Coverage inactive — out-of-window date

**Setup:** member's policy is effective `2026-06-01` to `2026-12-31`.

**Steps:** submit + adjudicate a `PT` line with `serviceDate = 2026-03-01` (before the
window).

**Observe:** `status = denied`, `reasons` contains `COVERAGE_INACTIVE`. The service type
is still classified by the member's most recent enrollment (so it's known, just
ineligible) — the denial is at gate 3, not gate 1.

---

### 3-C  Cross-claim duplicate detection

**Steps:**
1. Submit + adjudicate Claim 1: `PT`, `serviceDate = 2026-03-01` → approved.
2. Submit Claim 2 with the identical (`member`, `provider`, `serviceType`, `serviceDate`).
3. Adjudicate Claim 2.

**Observe:** line on Claim 2 gets `status = denied`, `reasons` contains `DUPLICATE`.
Accumulator unchanged from after Claim 1. The re-submission scenario is handled cleanly.

---

### 3-D  Limit fully exhausted — deductible delta still applies

**Setup:** `PT` rule: 20% coinsurance, $1000 annual limit, $500 deductible (all met).
`benefitUsed[PT]` already at $1000 (limit exhausted).

**Steps:** submit + adjudicate a new `PT` line, billed $300.

**Observe:** `status = denied`, `reasons` contains `LIMIT_EXHAUSTED`, `payable = 0`.
Crucially, `deductibleApplied = 0` (already met) and the accumulator's `deductibleMet`
is *not* further affected (deductible is met). If the deductible were not yet met, the
delta would still apply even on a limit-denied line — the member's deductible spend is
real for a covered service. This distinguishes a *covered service with an exhausted cap*
(deductible delta real) from a *hard-denied service* (no delta at all).

---

### 3-E  Invalid service type

**Steps:** submit a claim with `serviceType = "UNICORN"` (not in the plan's rule set).
Adjudicate.

**Observe:** `status = denied`, `reasons` contains `INVALID_LINE`. Confirms the
`serviceType` is validated against the plan's known rules, not trusted blindly.

---

## Set 4 — Manual review path

### 4-A  Pended → reviewer approves

**Setup:** plan with a `SURGERY` rule: `requiresManualReview = true`, 0% coinsurance,
$5000 annual limit.

**Steps:**
1. Submit + adjudicate a `SURGERY` line, billed $3000.
2. Observe: `status = pended`, claim `status = under_review`, no accumulator entry.
3. `POST /v1/lineitems/:id/review` with `{ "action": "approve" }`.
4. Observe: line `status = approved`, accumulator updated, claim re-derives.
5. `POST /v1/claims/:id/pay`.

**Observe:** the two-phase review path. The SURGERY line contributes to the accumulator
only after a human approves it, not at adjudication time.

---

### 4-B  Pended → reviewer denies

**Steps:** same setup through step 2, then `{ "action": "deny", "note": "Not medically
necessary" }`.

**Observe:** line `status = denied`, `reasons` contains `REVIEW_DENIED`, `payable = 0`,
no accumulator entry. The manual-review path and the hard-denial path produce the same
ledger result (no entry) when the reviewer says no.

---

### 4-C  Mixed claim — one pended, others adjudicated

**Setup:** plan with `PT` (no review) and `SURGERY` (requires review).

**Steps:**
1. Submit a claim with one `PT` line and one `SURGERY` line.
2. Adjudicate: `PT` → `approved`; `SURGERY` → `pended`; claim → `under_review`.
3. Review `SURGERY` → `approve`.
4. Claim re-derives: `approved` (both lines approved).

**Observe:** the claim status live-reflects the line-state multiset. At step 2 the
claim is `under_review` despite one line being approved; at step 3 it snaps to
`approved` with no stored state change on the claim itself.

---

## Set 5 — Disputes and overrides

### 5-A  Uphold (no change)

**Steps:**
1. Get a denied `COSMETIC` line (from Set 3-A).
2. `POST /v1/lineitems/:id/dispute` with `{ "reason": "I believe this should be covered" }`.
3. `POST /v1/disputes/:id/resolve` with `{ "action": "uphold", "note": "Exclusion confirmed" }`.

**Observe:** line status returns to `denied` (restored from `fromStatus`), claim
re-derives, `RESOLVED` event appended. No accumulator change. The uphold path is the
trivial case: close the dispute, no ledger work.

---

### 5-B  Overturn an exclusion — FORCE_COVERED

> Note: `FORCE_COVERED` is defined in the override taxonomy but not implemented in
> this scope (decisions.md §6). Use `MARK_ELIGIBLE` instead if the denied line is
> `COVERAGE_INACTIVE`, or `WAIVE_LIMIT` if limit-denied. The pattern is identical.

---

### 5-C  Overturn a limit-exhausted denial — WAIVE_LIMIT

**Setup:** `PT`, zero coinsurance, $2000 annual limit. First claim exhausts the limit.
Second claim's `PT` line is denied (`LIMIT_EXHAUSTED`).

**Steps:**
1. Adjudicate Claim 1 (exhausts limit).
2. Adjudicate Claim 2 → `PT` line `denied`, `LIMIT_EXHAUSTED`.
3. Dispute Claim 2's `PT` line.
4. Resolve with `{ "action": "overturn", "overrides": [{ "type": "WAIVE_LIMIT" }] }`.

**Observe:** line re-adjudicated with the `WAIVE_LIMIT` flag; payable = full billed
(or allowed); `benefitUsed[PT]` in the accumulator now exceeds the $2000 cap by the
paid amount. This is **intentional** — an override is an exception; the cap is waived,
and the ledger reflects it honestly.

---

### 5-D  Combined override — WAIVE_DEDUCTIBLE + WAIVE_LIMIT

**Setup:** member has unmet deductible AND a limit-exhausted `PT` benefit.

**Steps:**
1. Dispute the denied line.
2. Resolve with `{ "overrides": [{ "type": "WAIVE_DEDUCTIBLE" }, { "type": "WAIVE_LIMIT" }] }`.

**Observe:** both gates skipped in pipeline order; `deductibleApplied = 0` despite
remaining deductible; line approved for the full allowed amount. Overrides compose
without conflict because each targets a distinct pipeline gate.

---

### 5-E  Order-dependence — the documented limitation

**Setup:** member has $2000 PT limit. Claim A partially exhausts it (approved, $1500).
Claim B was then adjudicated while $500 remained; B's line was denied (`LIMIT_EXHAUSTED`).

**Steps:**
1. Dispute Claim B's line.
2. Resolve with `WAIVE_LIMIT` → B's line now approved for its full amount.
3. `GET /v1/members/:id/accumulators` → `benefitUsed[PT]` now > $2000.

**Observe:** the overturn is internally consistent for Claim B's line, but the total
exceeds the annual cap. A time-ordered re-adjudication from scratch might have awarded
the remaining $500 to Claim A's second line instead of to Claim B. **This is the
documented consistency boundary (decisions.md §7):** dispute resolution applies to one
line against the current ledger state, not a full cascade re-adjudication.

---

### 5-F  Re-dispute rejected — one dispute per line

**Steps:**
1. Submit + adjudicate a denied line.
2. Dispute it (`POST /v1/lineitems/:id/dispute`).
3. Resolve the dispute (`uphold`).
4. Try to dispute the same line again.

**Observe:** 409 on the second `POST /v1/lineitems/:id/dispute`. One appeal cycle per
line — multi-level appeals are a named cut.

---

## Set 6 — Concurrency and thread-safety

These are the pressure-test scenarios. Each fires multiple requests simultaneously
(`Promise.all` / parallel curl). The system must enforce its invariants under load.

### 6-A  Two claims for the same member, concurrent adjudication — limit must not be overspent

**Setup:** `PT` rule, $2000 annual limit. Submit two claims (C1: $2000, C2: $2000) on
different service dates (so they are not duplicates).

**Action:** fire `adjudicate(C1)` and `adjudicate(C2)` in parallel.

**Invariant:** `benefitUsed[PT]` after both settle = $2000. One claim is `approved`,
the other `denied` or `partially_approved`. **Never $4000.**

**Why it holds:** `adjudicateClaim` locks the `Member.version` row before summing the
ledger; the second transaction serializes behind the first, reads the updated total, and
sees no remaining limit.

---

### 6-B  Same claim adjudicated twice concurrently — one wins, ledger clean

**Setup:** submit a single claim C.

**Action:** fire `adjudicate(C)` and `adjudicate(C)` in parallel.

**Expected:** one call returns 200 with the adjudicated claim; the other returns 409
(`CONFLICT`). `GET /v1/members/:id/accumulators` shows each line's delta written
**exactly once** — not doubled.

**Why it holds:** after taking the member lock inside `$transaction`, the winner
re-reads the line statuses. The loser's re-read finds non-`submitted` lines and throws
`ConflictError` before touching the ledger.

---

### 6-C  Same claim paid twice concurrently — one wins, single PAID event

**Setup:** submit + adjudicate an `approved` claim.

**Action:** fire `pay(C)` and `pay(C)` in parallel.

**Expected:** one call returns 200; the other returns 409. `GET /v1/claims/:id` shows
**exactly one** `PAID` event in the timeline. `paidAmountCents` is set once, correctly.

**Why it holds:** `payClaim` takes the same member lock and re-reads line states under
it. The loser finds `status = paid` on the lines and throws `ConflictError`.

---

### 6-D  Same dispute resolved twice concurrently — one wins, single RESOLVED event

**Setup:** an open dispute on a denied line.

**Action:** fire `resolveDispute(D, "overturn", WAIVE_LIMIT)` and the same call in
parallel.

**Expected:** one 200, one 409. `GET /v1/claims/:id` shows exactly one `RESOLVED` event.
Accumulator moved exactly once — the loser never reached the engine.

**Why it holds:** `resolveDispute` re-reads `dispute.status` under the member lock.
The loser sees `status = resolved` and throws `ConflictError`.

---

### 6-E  Same pended line reviewed twice concurrently — one wins

**Setup:** a pended `SURGERY` line (from `requiresManualReview = true`).

**Action:** fire `reviewLine(L, "approve")` and the same call in parallel.

**Expected:** one 200, one 409. Exactly one `RESOLVED` event; accumulator entry written
once.

**Why it holds:** `reviewLine` re-reads `lineItem.status` under the member lock; the
loser sees the line is no longer `pended`.

---

### 6-F  N concurrent claims against a shared limit — total never exceeds cap

**Setup:** `PT` rule, $5000 annual limit. Submit 5 claims, each for $2000 PT (different
service dates so none are cross-claim duplicates).

**Action:** fire all 5 `adjudicate` calls in parallel.

**Expected:** `benefitUsed[PT]` = $5000 after all settle. Some claims are `approved`,
some `partially_approved` or `denied`. The exact distribution depends on serialization
order, but the total is always $5000.

**This is the most important scenario for the reviewer:** it demonstrates that the
serialization point is a real invariant, not a coincidence of timing, and that it holds
for a realistic multi-claim scenario (a member with multiple service dates hitting their
annual cap simultaneously).

---

## Set 7 — Input validation and invariant enforcement

### 7-A  Calendar-impossible date rejected — 422, no claim created

**Action:** `POST /v1/claims` with `serviceDate = "2026-02-30"`.

**Observe:** 422 (`VALIDATION_FAILED`). No claim row created. The validator requires
the parsed date to round-trip (30 Feb rolls to 2 Mar in `Date`, which doesn't equal the
input string). Protects the accumulator year-bucket from silent mis-classification.

---

### 7-B  Both copay and coinsurance set — 422 on plan creation

**Action:** try to create a `CoverageRule` with both `copayCents` and `coinsuranceRate`
set.

**Observe:** 422. The rule is rejected at the data boundary; the engine never sees an
ambiguous cost-share configuration.

---

### 7-C  Overlapping policy windows rejected — 409 on policy creation

**Setup:** member already has a policy `2026-01-01` to `2026-12-31`.

**Action:** try to create a second policy for the same member with `effectiveFrom =
"2026-06-01"` (overlapping).

**Observe:** 409. The non-overlap invariant is enforced at the write boundary so the
per-line coverage resolver can always find at most one active policy — making an
arbitrary pick impossible.

---

### 7-D  Copay exceeds allowed amount — payable clamps to 0, never negative

**Setup:** `OFFICE_VISIT` rule: copay $50, no annual limit. Zero deductible.

**Action:** submit a line billed $20 (less than the copay).

**Observe:** `allowedCents = 2000`, `memberCostShareCents = 2000` (copay clamped to
`costShareBase`), `payableCents = 0`, `memberResponsibilityCents = 2000`. No negative
values anywhere. The money invariant `payable + memberResponsibility == allowed` holds.

---

### 7-E  Deductible fully absorbs allowed — cost-share base is 0

**Setup:** `PT` rule: 20% coinsurance, $500 deductible, remaining = $500.

**Action:** submit a `PT` line billed $300.

**Observe:** `deductibleApplied = 30000`, `costShareBase = 0`, coinsurance applied to 0
→ `memberCostShare = 0`, `payable = 0`, `status = approved` (the line is covered; the
member just owes the deductible). Deductible accumulator increments by $300.

---

## Scenario sequencing for a live demo

A 10-minute evaluator walk-through that covers all the highlights:

| Step | What to show | Scenario |
|------|--------------|----------|
| 1 | Happy-path approval with copay breakdown | 1-A |
| 2 | Annual limit → partial approval with explanation | 2-B (second claim) |
| 3 | Deductible depletes across two claims | 2-A |
| 4 | Exclusion denial + duplicate detection | 3-A, 3-C |
| 5 | Manual review pended → approved → paid | 4-A |
| 6 | Dispute denied line → overturn with WAIVE_LIMIT | 5-C |
| 7 | Combined override (WAIVE_DEDUCTIBLE + WAIVE_LIMIT) | 5-D |
| 8 | Concurrent adjudication — limit not overspent | 6-A |
| 9 | Same claim twice concurrently — one 409, ledger clean | 6-B |
| 10 | N concurrent claims against shared cap | 6-F |

Steps 8–10 are the thread-safety showcase. Run them last so the evaluator has seen the
ledger behave correctly under sequential load before seeing it hold under concurrent load.
