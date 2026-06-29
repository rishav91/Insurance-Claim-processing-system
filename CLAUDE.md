# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Claims Processing System** for a health insurer, built as a take-home assignment. The point of the exercise is **domain modeling depth**, not feature count — the adjudication engine and its rules are what's graded, not CRUD plumbing. Read the assignment framing in `problem_statement.md` and `candidate_assignment_instructions.md`.

## Docs are the source of truth — read them before changing behavior

The design is specified *before* the code, and the code is expected to match it. When changing domain logic, update the relevant doc in the same change:

- **`docs/domain-model.md`** — the authoritative spec: entities, the dual state machines (line item vs. **derived** claim status), the adjudication pipeline ordering, the money model with its clamping invariant, the override taxonomy, and a numbered behavior-spec list (§7) that the tests implement. Section numbers (§3, §5, …) are referenced throughout the code comments and commit messages.
- **`docs/decisions.md`** — assumptions and deliberate cuts, each with rationale. If you make a new domain assumption or skip something, record it here.
- **`docs/domain-research.md`** — the insurance-domain background (adjudication, cost-sharing, accumulators, denial taxonomy). Reference, not spec.
- **`docs/roadmap.md`** — phased implementation checkpoints and current status. Phases 0–1 (pure domain core) are done; Phase 2 (Prisma persistence) is the next backbone step.

## Commands

All commands run from `app/`:

```bash
cd app
npm install
npm test                 # vitest run — all specs once
npm run test:watch       # vitest watch mode
npm run typecheck        # tsc --noEmit (strict; run before committing)

# A single file or test:
npx vitest run tests/cost-share.spec.ts
npx vitest run -t "exceeds the remaining annual limit"
```

There is no build, lint, or run step yet — the project is currently a pure, test-driven domain library (no HTTP/DB layer). Later phases add Prisma + a Fastify REST API per `docs/roadmap.md`.

## Architecture

The system is layered so the graded part — the rules engine — is **pure and I/O-free**.

### Pure domain core (`app/src/domain/`) — implemented
Each function is deterministic over plain values; no DB, no PHI.

- **`cost-share.ts` — `computeCostShare`**: the money model (domain-model.md §3). Runs `allowed → deductible → copay/coinsurance → annual limit`, clamping every step to ≥ 0. Upholds the invariant `payable + memberResponsibility === allowed`. Returns the breakdown, the emitted `reasons[]`, and an `accumulatorDelta`.
- **`adjudicate.ts` — `adjudicateLine`**: the per-line pipeline (domain-model.md §5). Gates 1–5 (validate → exclusion → eligibility → duplicate → manual-review) short-circuit; **hard denials produce a zero accumulator delta**, a pended line produces none. Gates 6–9 delegate to `computeCostShare`, then map the result to `approved | partially_approved | denied`. Reviewer **overrides** (e.g. `WAIVE_LIMIT`, `WAIVE_DEDUCTIBLE`, `OVERRIDE_ALLOWED_AMOUNT`) bypass their corresponding gate.
- **`adjudicate-claim.ts` — `adjudicateClaim`**: adjudicates a whole claim as one unit, processing lines in deterministic `(serviceDate, id)` order and **folding the accumulator forward** so two lines in the same claim cannot double-spend a shared limit/deductible. Each line reads/writes the accumulator for **its own service-date plan year** (`planYearOf`).
- **`claim-status.ts` — `deriveClaimStatus`**: total function mapping the multiset of line states to a claim status by first-match precedence. Claim status is **never stored**, always derived — this makes inconsistent states unrepresentable.
- **`types.ts`**: shared types. Money is **integer cents** everywhere. These types are intentionally **PHI-free** — the engine never receives member names, DOB, or diagnosis codes.

### Key invariants to preserve
- **Money is integer cents**; never floats. All arithmetic clamps to ≥ 0.
- **The engine takes no PHI.** Keep `adjudicateLine` / `adjudicateClaim` inputs limited to service type, dates, amounts, and accumulators.
- **`partially_approved` means exactly one thing**: a line paid up to the remaining annual limit with the excess denied. A line where the member merely owes a deductible/copay is still `approved`.
- **Two denial flavors differ**: a *hard* denial (gates 1–4) touches no money or accumulators; a *limit-exhausted* denial still applies its deductible delta.
- **The orchestration layer (future) gathers facts** (rule matching, eligibility, duplicate detection, accumulator load/save in one locking transaction) and calls the pure engine. Don't push I/O into the engine.

## Working style in this repo

- **Tests come first.** The git history shows red (failing spec) → green (implementation) pairs, one slice per concept. New behavior should follow the same rhythm: add/extend a `*.spec.ts` that encodes the domain rule, watch it fail, then implement. Tests assert domain outcomes (amounts, statuses, reason codes), not return types.
- **Commit messages reference the doc section** they implement (e.g. "domain-model.md §5") and state red/green.
- **Strict TypeScript**: `exactOptionalPropertyTypes` is on — build optional-property objects with conditional spreads rather than assigning `undefined`.
