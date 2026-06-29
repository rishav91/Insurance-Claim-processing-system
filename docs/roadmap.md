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

## Phase 2 — Persistence (Prisma + SQLite) 🔜
Make the entities durable; the schema doubles as living domain-model docs.
- ⬜ Prisma schema: `Member`, `Policy`, `CoverageRule`, `Provider`, `Claim`,
  `LineItem`, `Accumulator`, `Dispute` (+ enums for statuses/reason codes).
- ⬜ Money stored as integer cents; `Accumulator` carries a `version` column for
  optimistic locking (concurrency invariant, decisions.md §5).
- ⬜ Migration + a thin repository layer (or Prisma client directly) behind
  small typed functions.
- **Tests:** a repository round-trip test (create policy+rules → read back).
- **Risk/decision:** keep repositories thin; no generic DAL abstraction.

## Phase 3 — Orchestration service ⬜
Wire the pure engine to the database. This is where the "gather facts" work lives.
- ⬜ `submitClaim(input)`:
  1. load member → policy → rules; match a rule per line's serviceType.
  2. compute `coverageActive` (policy effective window vs serviceDate).
  3. detect duplicates (prior non-denied line on
     `(member, serviceType, serviceDate, provider)`).
  4. load accumulators for the relevant `(member, planYear)` rows.
  5. call `adjudicateClaim` (pure).
  6. **persist line results + accumulator deltas in ONE transaction** that locks
     the accumulator row(s) — the serialization point.
- ⬜ `getClaim(id)` → claim + lines + per-line adjudication breakdown + reasons.
- **Tests (domain-level, against a test DB):**
  - deductible depletes across **two separate claims** (the cross-claim spec).
  - concurrent submissions for one member don't overspend a limit
    (serialization invariant).
  - a duplicate line on a second claim is denied `DUPLICATE`.

## Phase 4 — Disputes & manual-review resolution ⬜
One reconciliation path (domain-model.md §6).
- ⬜ `disputeLine(lineId, reason)` → line `disputed`, claim re-derives.
- ⬜ `resolveLine(lineId, action, overrides?, note)`:
  reverse prior delta → re-run `adjudicateLine` (with `skipManualReview` and any
  overrides) → apply new delta → re-derive claim status, all in one txn.
- ⬜ Guard: a `paid` line is **not** disputable (documented cut).
- **Tests:**
  - overturn a denied line with `WAIVE_LIMIT` → it pays; accumulators move.
  - combine `{WAIVE_DEDUCTIBLE, WAIVE_LIMIT}` in one resolution.
  - resolve a pended line via `approve` applies the delta; `deny` applies none.
  - the **order-dependence** spec (overturn can push benefitUsed past cap) — the
    documented limitation, made visible.

## Phase 5 — REST API (Fastify) ⬜
The interface to demo with. Thin handlers over the service; validation with zod.
- ⬜ `POST /claims` — submit a claim with line items.
- ⬜ `GET /claims/:id` — claim + line decisions + explanations.
- ⬜ `POST /lineitems/:id/dispute` — open a dispute.
- ⬜ `POST /disputes/:id/resolve` — uphold/overturn (+ overrides).
- ⬜ `POST /lineitems/:id/review` — resolve a pended line.
- ⬜ Validation: malformed → 422 (claim not created); domain-invalid → adjudicated `denied`.
- **Tests:** a couple of API-level happy/edge paths (not status-code-only —
  assert the adjudication payload).

## Phase 6 — Seed data ⬜
- ⬜ Seed script: a member + policy with a realistic rule set (office visit with
  copay, PT with coinsurance + annual limit, surgery requiring manual review, an
  excluded cosmetic service, a fee-scheduled service) + a provider.
- ⬜ Make the demo flows reproducible from a clean DB.

## Phase 7 — End-to-end demo flows ⬜
- ⬜ A scripted walk-through (curl or a `.http` file / short script) covering:
  submit → partial approval → dispute → overturn → pended review. This is the
  "walk us through it" artifact.

## Phase 8 — Docs & submission polish ⬜
- ⬜ `README.md` — setup, run, test, and the demo walkthrough.
- ⬜ `docs/self-review.md` — what's good, what's rough, what I'd change.
- ⬜ Reconcile `decisions.md` with anything that shifted during the build.
- ⬜ Export raw JSONL session logs into `ai-artifacts/`.
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
