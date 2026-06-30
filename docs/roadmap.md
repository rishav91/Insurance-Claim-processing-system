# Implementation Roadmap

> The path from the current state to a complete, runnable submission. Each
> checkpoint is a small, committable slice (tests-first where it applies). Status
> legend: ✅ done · 🔜 next · ⬜ planned.

## Goal & definition of done

A locally-runnable Claims Processing System that:
1. accepts a claim with line items,
2. adjudicates each line against coverage rules (with accumulators),
3. moves claims/lines through their lifecycle,
4. explains every decision,
5. supports disputes + manual review,

plus the four doc deliverables (`domain-model`, `decisions`, `self-review`,
`README`) and a clean TDD git history with JSONL logs.

Mapping to the assignment's required deliverables:

| Deliverable | Where it comes from |
|---|---|
| `app/` working system | Phases 0–7 |
| `docs/domain-model.md` | ✅ done |
| `docs/decisions.md` | ✅ done (updated as cuts are confirmed) |
| `docs/self-review.md` | Phase 8 |
| `README.md` | Phase 8 |
| `.git/` history | every phase commits in red→green slices |
| JSONL session logs | exported at the end |

---

## Phase 0 — Project scaffold ✅
- TS + Vitest, strict tsconfig, PHI-free domain types.
- **Commit:** `test: scaffold + failing cost-share specs`.

## Phase 1 — Pure domain core ✅ (35 specs, tsc clean)
The graded heart of the system. No I/O.
- ✅ `computeCostShare` — clamped money model (allowed→deductible→cost-share→limit).
- ✅ `adjudicateLine` — per-line pipeline: hard denials, manual-review pend, overrides.
- ✅ `deriveClaimStatus` — rollup precedence as a total function.
- ✅ `adjudicateClaim` — intra-claim accumulator folding (**blocker fixed**) + plan-year-by-service-date.

---

## Phase 2 — Persistence (Prisma + SQLite) ✅ (38 specs, tsc clean)
Make the entities durable; the schema doubles as living domain-model docs.
- ✅ Prisma schema: `Plan`, `CoverageRule` (FK→Plan), `Policy` (Member↔Plan +
  effective window), `Member`, `Provider`, `Claim` (+ `paidAmountCents`/`paidAt`),
  `LineItem`, `AccumulatorEntry` (ledger), `Dispute`, `Event`. Statuses are
  `String`s constrained by the TS unions (SQLite has no native enums); **`Claim`
  has no status column — it is derived from its lines (§4)**.
- ✅ Money stored as integer cents. Usage is the **sum of active `AccumulatorEntry`
  rows** (`loadAccumulators` groups on read), not a stored total; index
  `(memberId, planYear, serviceType, voided)`.
- ✅ Thin repository layer (`src/db/repositories.ts`) behind small typed
  functions — no generic DAL abstraction.
- ✅ **Tests:** repository round-trip (create plan+rules+policy → read back) and a
  ledger-sum read (`benefitUsed` = Σ active entries, voided excluded, per plan year).
- Test harness: vitest `globalSetup` pushes a fresh SQLite schema; single fork so
  the single-writer ledger invariant is exercised, not masked.

## Phase 3 — Orchestration service ✅ (46 specs, tsc clean)
Wire the pure engine to the database. This is where the "gather facts" work lives.
- ✅ `submitClaim(input)` → persist claim + lines as `submitted`, append a
  `SUBMITTED` event. No adjudication yet (two-step decision, decisions.md §4).
- ✅ `adjudicateClaim(claimId)`:
  1. load member → policy → **plan** → rules; match a rule per line's serviceType.
  2. compute `coverageActive` (policy effective window vs serviceDate).
  3. detect duplicates (prior adjudicated non-denied line on
     `(member, serviceType, serviceDate, provider)`, on a different claim).
  4. **sum the active ledger entries** for the relevant `(member, planYear, serviceType)`.
  5. call the pure `adjudicateClaim` engine.
  6. **in ONE transaction that locks the member row** (`Member.version` bump +
     SQLite `connection_limit=1`): write one `AccumulatorEntry` per finalized
     line, persist line results, append `ADJUDICATED`/`PENDED` events.
- ✅ `getClaim(id)` → claim + lines + per-line adjudication breakdown + reasons (+ events).
- ✅ **Tests (domain-level, against a test DB):**
  - deductible depletes across **two separate claims** (the cross-claim spec).
  - `benefitUsed` reads as the sum of active ledger entries.
  - concurrent submissions for one member don't overspend a limit
    (serialization invariant).
  - a duplicate line on a second claim is denied `DUPLICATE`.
  - (bonus) out-of-window line → `COVERAGE_INACTIVE`; `requiresManualReview` → pended.

## Phase 4 — Disputes & manual-review resolution ✅ (54 specs, tsc clean)
One reconciliation path (domain-model.md §6).
- ✅ `disputeLine(lineId, reason)` → line `disputed`, claim re-derives; records the
  pre-dispute status on the `Dispute` (`fromStatus`) so `uphold` can restore it.
- ✅ `resolveDispute(lineId, uphold|overturn, overrides?, note)` and
  `reviewLine(lineId, approve|deny, …)` share one core: void the prior active
  `AccumulatorEntry` → re-run `adjudicateLine` (`skipManualReview` + overrides) →
  write a fresh entry → re-derive claim status → append `RESOLVED`, all in one
  member-locked txn. `uphold` restores the original outcome; `deny` finalizes
  denied (`REVIEW_DENIED`) with no ledger effect.
- ✅ Guard: a `paid` (and `pended`) line is **not** disputable.
- ✅ **Schema fix the model forced:** `AccumulatorEntry.lineItemId` is no longer
  `@unique` — a line keeps voided entries (audit) alongside one active entry.
- ✅ **Tests:**
  - overturn a denied line with `WAIVE_LIMIT` → it pays; accumulators move.
  - combine `{WAIVE_DEDUCTIBLE, WAIVE_LIMIT}` in one resolution.
  - resolve a pended line via `approve` applies the delta; `deny` applies none.
  - void-then-rewrite leaves usage = Σ active entries (no drift); old entry voided.
  - the **order-dependence** spec (overturn can push benefitUsed past cap) — the
    documented limitation, made visible.

## Phase 5 — REST API (Fastify) ✅ (67 specs, tsc clean)
The interface to demo with. Thin handlers over the service; validation with zod.
Full contract → `docs/api.md`. Runnable via `npm run dev` (tsx).
- ✅ All 10 endpoints wired as thin handlers (`src/http/app.ts`): submit,
  adjudicate, get/list claims, pay, dispute, get/resolve dispute, review pended,
  member accumulators.
- ✅ zod-validated bodies; the nested `adjudication` wire shape; one error envelope.
- ✅ Validation: malformed → 422 (no claim created); conflicting
  `OVERRIDE_ALLOWED_AMOUNT` → 422; illegal transitions → 409; unknown id → 404.
  Domain-invalid lines still create the claim and adjudicate to `denied`.
- ✅ **Tests:** fastify.inject happy/edge paths asserting the adjudication payload
  (submit→adjudicate partial, dispute→overturn, accumulators), not just codes.

## Phase 6 — Seed data ✅
- ✅ `prisma/seed.ts` (`npm run db:seed` / `prisma db seed`): 4 plans (Gold PPO
  2026, Silver HMO 2026, Bronze HDHP 2025 expired, Bronze HDHP 2026 renewal),
  1 shared provider, 5 members with deliberately varied mid-year accumulator
  states (deductible partially/fully met, benefit limits near/at cap, expired
  policy, clean slate). Prior-history claims are adjudicated by the real engine
  so the ledger entries are authentic.
- ✅ `npm run db:reset` resets schema and reseeds atomically.
- ✅ Documented in `docs/demo-scenarios.md` (member states table).

## Phase 7 — End-to-end demo flows ✅
- ✅ `demo/run.ts` (`npm run demo`): self-contained walk-through script —
  resets + reseeds the DB, then exercises 8 scenarios end-to-end against the
  real service layer (same functions the HTTP handlers call):
    1. Office visit copay → approved (invariant check printed)
    2. PT near annual limit → partial approval with full money breakdown
    3. Deductible depletes across two claims (before/after accumulators)
    4. Exclusion denial + cross-claim duplicate detection
    5. Manual review: SURGERY pended → reviewer approves → paid
    6. Dispute + WAIVE_LIMIT overturn (order-dependence made visible)
    7. Concurrent adjudication — shared limit never overspent (`Promise.all`)
    8. Same claim adjudicated twice concurrently — one 409, ledger untouched
  Each scenario prints the HTTP-equivalent calls, key money fields, and a
  prose "WHAT TO OBSERVE" explanation for the evaluator.

## Phase 8 — Docs & submission polish ✅
- ✅ `README.md` — setup, run, test, and the demo walkthrough.
- ✅ `docs/self-review.md` — what's good, what's rough, what I'd change.
- ✅ Reconcile `decisions.md` with anything that shifted during the build.
- ✅ Export raw JSONL session logs into `ai-artifacts/`.
- ⬜ Final pass: `npm test` green from a clean clone, README steps verified.

---

## Sequencing notes
- **Critical path:** Phase 2 → 3 are the backbone; 4 reuses 3's txn pattern; 5 is
  thin once 3/4 exist.
- **Keep slices small:** each ⬜ above is ~1 commit, tests alongside.
- **Demoability gate:** after Phase 5 + 6 the system is curl-able end-to-end —
  the minimum "working system" bar. Phases 7–8 make it reviewable.
- **Time risk:** if time is short, Phase 4 disputes can ship with override-only
  resolution (already the plan) and the order-dependence limitation documented
  rather than solved.
