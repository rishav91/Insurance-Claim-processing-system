# Domain Research — Insurance Claims Processing

> Background research for the Claims Processing System. Captures the domain
> vocabulary and the real-world rules that the code's abstractions map onto.
> This is reference material, not a spec — the actual scope lives in
> `domain-model.md` / `decisions.md`.

## 1. The big picture

When a member incurs a medical expense, the payer (insurance company) must answer
two questions, **line item by line item**:

1. **Is it covered?** (does the policy include this, is coverage active, is it valid)
2. **Of the covered amount, who pays what?** (cost-sharing math)

The process of answering these and arriving at a payable amount is **adjudication**.
Everything else — submission, state tracking, explanations, disputes — feeds,
tracks, or explains adjudication.

Mental model: a claim is a *request for money*; adjudication is a deterministic
function `(claim, policy, accumulated usage) -> (payable, decision, reason)`.

## 2. Core actors & artifacts

| Term | Meaning | Modeling note |
|---|---|---|
| **Member** | Insured person. *Subscriber* (policyholder) vs *dependent*. | Carries PHI. |
| **Provider** | Doctor/clinic that delivered the service. **In-network** = negotiated rate; **out-of-network** = different cost-sharing. | Network status is an adjudication input. |
| **Payer** | The insurer — the system we are building. | — |
| **Policy / Plan** | Contract defining coverage + cost-sharing rules. | Where coverage rules live. |
| **Claim** | A submitted reimbursement request, one or more services. | Has a lifecycle. |
| **Line item / Service line** | A single billable service (one procedure, one date, one amount). | **Adjudication is per line item** — the crux of partial approvals. |

## 3. Adjudication — the central term

For each line item, adjudication decides:

1. **Covered?** Service type in policy? Provider eligible? Coverage active on service date?
2. **Valid?** Required fields present? Duplicate? Diagnosis supports the procedure (*medical necessity*)?
3. **How much?** Apply cost-sharing math + limits.

Output: a **decision** (approved / denied / partially approved / pended) + the
**payable amount** + a structured **reason**.

- **Auto-adjudication** — rules engine decides, no human (our focus).
- **Manual review ("pended")** — kicked to a human when rules can't decide. Maps to the
  "1 line item needs review" case.

## 4. Cost-sharing — the money math

The member and insurer *share* cost. Order of application matters.

- **Billed amount** — what the provider charged.
- **Allowed amount** — max the insurer recognizes (often a negotiated rate below billed).
  The in-network difference is written off (not billable to member). **Billed ≠ allowed ≠ paid.**
- **Deductible** — fixed amount the member pays out of pocket before the insurer pays
  anything. Accumulates across claims within a policy year.
- **Copay** — *fixed dollar* amount per service type ($30/office visit). Flat, per-visit.
- **Coinsurance** — *percentage* split after deductible (80/20 = insurer 80%, member 20%).
- **Out-of-pocket (OOP) maximum** — annual ceiling on member's total cost-share; once hit,
  insurer pays 100% for the rest of the year. Another accumulator.

**Pipeline order:** `allowed → deductible → copay/coinsurance → OOP-max check → benefit-limit check`.

Worked example — $500 allowed, deductible met, 80/20 coinsurance:
`deductible $0 → coinsurance: member $100 / insurer $400 → payable = $400`.

## 5. Coverage rules & limits

- **Annual / lifetime dollar limit** — max $ paid for a service type per period.
- **Visit / quantity limit** — "20 PT sessions per year".
- **Frequency limit** — "one physical per 12 months".
- **Exclusions** — never covered (cosmetic, experimental).
- **Waiting period** — coverage starts N months in.
- **Pre-authorization required** — must be approved before service or it's denied.

Key insight: **limits require tracking accumulated usage.** Running totals
(deductible-met, OOP-met, benefit-used) are **accumulators**: adjudication reads them
and writes to them — raises ordering/concurrency questions.

## 6. Codes

- **Diagnosis codes (ICD-10)** — *why* (the condition), e.g. `E11.9` = type 2 diabetes.
- **Procedure codes** — *what* was done. **CPT** (e.g. `99213` office visit), **HCPCS** (supplies/drugs).
- **Medical necessity** — diagnosis must justify the procedure; mismatch is a common denial.

We don't need real code sets, but `serviceType` / `procedureCode` + `diagnosisCode`
fields give realistic adjudication inputs and denial reasons.

## 7. Denial taxonomy — the "WHY"

Real payers use standardized **CARC/RARC** codes; the *categories* are what matter:

| Category | Example |
|---|---|
| Not covered / excluded | Service type not in benefits |
| Eligibility | Coverage inactive on service date |
| Limit exhausted | Annual benefit max reached |
| Duplicate | Same service already claimed |
| Missing/invalid info | No diagnosis code |
| Medical necessity | Diagnosis doesn't support procedure |
| No pre-authorization | Required approval missing |
| Provider issue | Out-of-network / non-covered provider |

A good design attaches a **structured reason** (code + human message + the triggering
rule/limit) to every non-full-payment — that's what makes explanations testable.

## 8. State machines — claim vs. line item

A claim and its line items have *different* lifecycles; the claim's state is a
**rollup** of its line items'.

**Line item:** `submitted → in_review → approved | partially_approved | denied → paid`

**Claim:** `submitted → under_review → approved | partially_approved | denied → paid → (disputed → reopened)`

Rollup logic (the "5 items: 3 covered, 1 denied, 1 review" case):
- Any line pended → claim **under_review** (can't finalize).
- All resolved, some approved + some denied → **partially_approved**.
- All denied → **denied**; all approved → **approved**.
- Paid amount = sum of approved line items' payable amounts.

Model claim status as **derived** from line items, not independently mutable.

## 9. Disputes / appeals

Members can **dispute** (formally *appeal*) a decision. Real world is multi-level
(internal → external). For our scope: a finalized claim/line item can be **disputed**,
moving it to a `disputed` state and triggering re-adjudication or manual review,
possibly overturning the decision. Design question: dispute per line item or whole claim?
(Per-line is more correct and more interesting.)

## 10. PHI / sensitive data

Claims contain **PHI** (member names, diagnosis codes, provider details). Under HIPAA
this drives design decisions worth *naming* even if not fully implemented:
- Minimize/separate PHI fields; don't log diagnosis codes in plaintext audit logs.
- Audit trail of who-viewed/changed-what.
- Adjudication can run on codes without exposing names (PHI vs non-PHI separation).

## 11. Mapping to the model

- **Entities:** `Member`, `Policy` (+ `CoverageRule`s), `Provider`, `Claim` → `LineItem`,
  `Accumulator` (per member/year), `AdjudicationResult`/`Decision` (+ reason), `Dispute`.
- **Adjudication engine:** a pure-ish function (line item + rules + accumulators →
  decision + payable + reason) whose effects (accumulator updates) apply transactionally.
- **Coverage rules** are the centerpiece. Representation left open (code vs config vs DSL).
  Data-driven rules (`serviceType`, `coveragePct`, `copay`, `annualLimit`, `requiresPreauth`,
  `excluded`) interpreted by the engine separates policy *data* from adjudication *logic*.
