# Claims Processing System

A locally-runnable health insurance claims adjudication engine, built as a take-home assignment.
The emphasis is on **domain modeling depth** — the rules engine, accumulator ledger, and dispute lifecycle — not CRUD plumbing.

## What it does

1. **Accepts** claims with one or more line items (service type, date, billed amount).
2. **Adjudicates** each line against coverage rules: exclusion → eligibility → duplicate → manual-review → cost-share (deductible → copay/coinsurance → annual limit). Every step emits a reason code.
3. **Tracks accumulators** as an append-only ledger so usage is always the sum of active entries — dispute reversal voids an entry rather than reversing arithmetic.
4. **Derives claim status** from its lines as a pure function (`deriveClaimStatus`) — claim status is never stored, so inconsistent states are unrepresentable.
5. **Supports disputes** and manual-review resolution: void the prior ledger entry, re-run the engine, write a fresh entry, all in one member-locked transaction.

Full design: [`docs/domain-model.md`](docs/domain-model.md) · [`docs/decisions.md`](docs/decisions.md) · [`docs/api.md`](docs/api.md)

---

## Prerequisites

- **Node.js** ≥ 20 (LTS)
- **npm** ≥ 9

No other infrastructure — the database is a local SQLite file.

---

## Quick start

### Option A — Automated (recommended)

> **Zip download:** the zip ships `setup.sh.txt` to work around Gmail's `.sh` block. Rename it first:
> ```bash
> mv setup.sh.txt setup.sh && chmod +x setup.sh
> ```

Run from the repo root:

```bash
./setup.sh
```

This copies `.env.example`, installs deps, resets the DB, runs the test suite, and plays the demo. Then start the server:

```bash
cd app && npm run dev
```

---

### Option B — Manual

```bash
# 1. Copy env file (sets DATABASE_URL)
cp app/.env.example app/.env

# 2. Install dependencies
cd app
npm install

# 3. Push the schema and seed reference data
#    (creates app/prisma/dev.db with 4 plans, 5 members, pre-built accumulator history)
npm run db:reset

# 4. Run the test suite — should be 86 tests, all green
npm test

# 5. Run the self-contained demo (8 scenarios, prints annotated output)
npm run demo

# 6. Start the API server (port 3000)
npm run dev
```

> `npm run db:reset` = `prisma db push --force-reset` + seed. Run it any time you want
> a clean slate. Individual reset: `npm run db:push` (schema only) or `npm run db:seed`.

> **Troubleshooting:** If `db:reset` fails with _"The database disk image is malformed"_, a previous
> interrupted reset left a corrupt file behind. Wipe it first:
> ```bash
> rm -f prisma/dev.db prisma/dev.db-shm prisma/dev.db-wal && npm run db:reset
> ```

---

## Running tests

```bash
cd app
npm test                                          # all specs once
npm run test:watch                                # vitest watch
npm run typecheck                                 # strict tsc check (no emit)

# Single file or single test name:
npx vitest run tests/adjudicate-orchestration.spec.ts
npx vitest run -t "deductible depletes across two claims"
```

Tests are behavior-first: each spec encodes a domain rule from `docs/domain-model.md §7`.
The git history shows the red → green slices.

---

## Inspecting the database

[Prisma Studio](https://www.prisma.io/studio) is bundled with the project — no separate install needed.

```bash
cd app
npx prisma studio          # opens http://localhost:5555
```

The browser UI shows every table (`Member`, `Plan`, `Policy`, `Claim`, `LineItem`,
`AccumulatorEntry`, `AuditLog`, …) with clickable relations. Useful for verifying seeded
accumulator history, checking claim state after running the demo, or browsing the ledger
entries produced by a dispute resolution.

---

## Demo walkthrough

`npm run demo` resets and reseeds `dev.db`, then exercises 8 end-to-end scenarios against
the same service functions the HTTP handlers call. Each scenario prints the equivalent API
calls, the money breakdown, and a prose "WHAT TO OBSERVE" explanation.

| # | Scenario | What it shows |
|---|---|---|
| 1 | Office visit copay → approved | Copay applied; member owes cost-share but status is still `approved` |
| 2 | PT near annual limit → partially approved | Limit overflow produces `partially_approved`; `payable + member = allowed` invariant printed |
| 3 | Deductible depletes across two claims | Cross-claim accumulator: second claim sees the first's deductible delta |
| 4 | Exclusion denial + cross-claim duplicate | Hard denial touches no money; duplicate line on second claim denied `DUPLICATE` |
| 5 | SURGERY pended → reviewer approves → paid | Manual-review gate, approval, then terminal `paid` transition |
| 6 | Dispute + WAIVE_LIMIT overturn | Void-then-rewrite reconciliation; order-dependence printed as a documented limitation |
| 7 | Concurrent adjudication — shared limit | `Promise.all` on two claims; serialization ensures limit never overspent |
| 8 | Same claim adjudicated twice | One 409, ledger untouched — idempotent guard works |

---

## API

Base path: `http://localhost:3000/v1`. All money fields are **integer cents**.
Full contract in [`docs/api.md`](docs/api.md).

### Key endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/claims` | Submit a claim → `201 submitted` |
| `POST` | `/v1/claims/:id/adjudicate` | Run adjudication → 200 with full breakdown |
| `GET` | `/v1/claims/:id` | Fetch claim + lines + reasons |
| `GET` | `/v1/claims?memberId=` | List a member's claims |
| `POST` | `/v1/claims/:id/pay` | Mark approved claim paid |
| `POST` | `/v1/lineitems/:id/dispute` | Open a dispute on a line |
| `POST` | `/v1/disputes/:id/resolve` | Uphold or overturn with optional overrides |
| `POST` | `/v1/lineitems/:id/review` | Approve or deny a pended line |
| `GET` | `/v1/members/:id/accumulators` | Live accumulator totals (summed from ledger) |

### Minimal curl flow

```bash
# Submit
curl -s -X POST http://localhost:3000/v1/claims \
  -H 'Content-Type: application/json' \
  -d '{
    "memberId": "<alice-id>",
    "providerId": "<provider-id>",
    "lineItems": [{
      "serviceType": "OFFICE_VISIT",
      "serviceDate": "2026-06-01",
      "billedAmountCents": 20000
    }]
  }' | jq .

# Adjudicate (use the id from the submit response)
curl -s -X POST http://localhost:3000/v1/claims/<claim-id>/adjudicate | jq .

# Accumulators
curl -s "http://localhost:3000/v1/members/<alice-id>/accumulators?planYear=2026" | jq .
```

Member and provider IDs are printed by `npm run db:seed` and stored in `dev.db`.

### Error envelope

```json
{ "error": { "code": "CONFLICT", "message": "claim already adjudicated" } }
```

Status codes: `200` success · `201` created · `404` not found · `409` illegal transition · `422` validation failure.

---

## Project structure

```
app/
  src/
    domain/          # Pure engine — no I/O, no PHI
      cost-share.ts      computeCostShare   (allowed → deductible → copay/coinsurance → limit)
      adjudicate.ts      adjudicateLine     (per-line pipeline, gates 1–9)
      adjudicate-claim.ts adjudicateClaim   (intra-claim accumulator folding)
      claim-status.ts    deriveClaimStatus  (pure total function)
      types.ts           shared domain types (integer cents, union statuses)
    db/
      repositories.ts    typed repository functions (no generic DAL)
      client.ts          Prisma client singleton
    services/
      claims.ts          orchestration (gather facts → call engine → persist in one txn)
      errors.ts          ConflictError / NotFoundError / ValidationError
    http/
      app.ts             Fastify routes (thin handlers, zod validation)
      schemas.ts         zod schemas
      serialize.ts       DB model → wire view
  tests/               Behavior-first specs (red→green with the domain)
  demo/run.ts          End-to-end walk-through script
  prisma/
    schema.prisma      Schema (also living domain-model docs)
    seed.ts            Reference data seeder
docs/
  domain-model.md      Authoritative spec (entities, state machines, money model, §7 behavior list)
  decisions.md         Assumptions and deliberate cuts with rationale
  api.md               REST contract
  demo-scenarios.md    Scenario catalogue
  roadmap.md           Phased implementation history
```

---

## Design highlights

- **Pure engine, no PHI** — `adjudicateLine` receives only service type, dates, amounts, and accumulators. The entire rules engine is PHI-free by construction.
- **Ledger, not a counter** — accumulators are `SUM(active AccumulatorEntry)`, not a mutated total. Dispute reversal = void the entry; no arithmetic drift.
- **Claim status is derived** — `deriveClaimStatus(lineStates[])` is a total pure function; claim status is never stored, so partial approvals fall out naturally and inconsistent states are unrepresentable.
- **Member-row locking** — `adjudicateClaim` bumps `Member.version` inside its transaction before summing the ledger, making the sum→decide→insert sequence atomic. The Postgres equivalent is `SELECT … FOR UPDATE` on the member row.
- **Coverage resolved per line, by date of service** — each line finds the policy whose effective window contains its own `serviceDate`, so a claim straddling a renewal adjudicates correctly without the submitter choosing the plan.

See [`docs/decisions.md`](docs/decisions.md) for the full rationale behind every significant choice.
