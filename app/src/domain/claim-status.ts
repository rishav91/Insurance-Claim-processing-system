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
  if (all("paid")) return "paid"; //                            2. fully disbursed (terminal)
  if (all("denied")) return "denied"; //                        3.
  if (all("approved")) return "approved"; //                    4.
  return "partially_approved"; //                               5. any surviving mix
}
