import { z } from "zod";

/** ISO calendar date, e.g. "2026-03-01". */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");
const cents = z.number().int().nonnegative();

export const submitClaimSchema = z.object({
  memberId: z.string().min(1),
  providerId: z.string().min(1),
  lineItems: z
    .array(
      z.object({
        serviceType: z.string().min(1),
        serviceDate: isoDate,
        diagnosisCode: z.string().optional(),
        billedAmountCents: cents,
      }),
    )
    .min(1, "at least one line item is required"),
});

/** Reviewer override directives (domain-model.md §5 taxonomy). */
const overrideSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("FORCE_COVERED") }),
  z.object({ type: z.literal("MARK_ELIGIBLE") }),
  z.object({ type: z.literal("ALLOW_DUPLICATE") }),
  z.object({ type: z.literal("WAIVE_DEDUCTIBLE") }),
  z.object({ type: z.literal("WAIVE_LIMIT") }),
  z.object({ type: z.literal("OVERRIDE_ALLOWED_AMOUNT"), valueCents: cents }),
]);

/** At most one parameterized OVERRIDE_ALLOWED_AMOUNT (two values are ambiguous, §5). */
const overrides = z
  .array(overrideSchema)
  .refine(
    (arr) => arr.filter((o) => o.type === "OVERRIDE_ALLOWED_AMOUNT").length <= 1,
    { message: "at most one OVERRIDE_ALLOWED_AMOUNT may be applied" },
  )
  .optional();

export const disputeSchema = z.object({
  reason: z.string().min(1),
});

export const resolveDisputeSchema = z.object({
  action: z.enum(["uphold", "overturn"]),
  overrides,
  note: z.string().optional(),
});

export const reviewSchema = z.object({
  action: z.enum(["approve", "deny"]),
  overrides,
  note: z.string().optional(),
});

export const planYearQuerySchema = z.object({
  planYear: z.coerce.number().int().optional(),
});

export type SubmitClaimBody = z.infer<typeof submitClaimSchema>;
