import type { ClaimView, LineView } from "../services/claims.js";

/**
 * Wire serialization (docs/api.md). The money breakdown is nested under
 * `adjudication` and only present once a line has been adjudicated (payable set);
 * a `submitted` line carries no `adjudication` block.
 */
function serializeLine(l: LineView) {
  const base = {
    id: l.id,
    serviceType: l.serviceType,
    serviceDate: l.serviceDate,
    status: l.status,
    billedAmountCents: l.billedAmountCents,
  };
  if (l.payableCents === null) return base;
  return {
    ...base,
    adjudication: {
      allowedCents: l.allowedCents,
      deductibleAppliedCents: l.deductibleAppliedCents,
      memberCostShareCents: l.memberCostShareCents,
      payableCents: l.payableCents,
      memberResponsibilityCents: l.memberResponsibilityCents,
      reasons: l.reasons,
    },
  };
}

export function serializeClaim(v: ClaimView) {
  return {
    id: v.id,
    status: v.status,
    memberId: v.memberId,
    providerId: v.providerId,
    submittedAt: v.submittedAt,
    paidAmountCents: v.paidAmountCents,
    paidAt: v.paidAt,
    lineItems: v.lineItems.map(serializeLine),
    events: v.events.map((e) => ({
      type: e.type,
      actor: e.actor,
      createdAt: e.createdAt,
      ...(e.lineItemId && { lineItemId: e.lineItemId }),
      ...(e.fromState && { fromState: e.fromState }),
      ...(e.toState && { toState: e.toState }),
      ...(e.note && { note: e.note }),
    })),
  };
}
