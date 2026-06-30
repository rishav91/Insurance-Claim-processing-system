import type { ClaimStatus, LineStatus } from "./types.js";

/**
 * Derive a claim's status from the multiset of its line-item states
 * (domain-model.md §4). A total pure function evaluated by first-matching
 * precedence — claim status is never stored independently, so inconsistent
 * states are unrepresentable.
 */
export function deriveClaimStatus(lineStates: LineStatus[]): ClaimStatus {
  if (lineStates.length === 0) return "submitted";

  const has = (s: LineStatus): boolean => lineStates.includes(s);
  const all = (s: LineStatus): boolean => lineStates.every((x) => x === s);

  // Precedence (top wins):
  if (has("pended") || has("disputed")) return "under_review"; // 1. cannot finalize
  if (all("submitted")) return "submitted"; //                    nothing adjudicated yet
  // 2. disbursed (terminal): every line is paid-or-denied with at least one paid.
  //    A partially-denied claim, once paid, is terminal — not partially_approved.
  if (has("paid") && lineStates.every((s) => s === "paid" || s === "denied")) return "paid";
  if (all("denied")) return "denied"; //                        3.
  if (all("approved")) return "approved"; //                    4.
  return "partially_approved"; //                               5. any surviving mix
}
