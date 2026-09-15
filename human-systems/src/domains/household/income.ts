/**
 * Household domain: the income-source collection item. Until schema v5
 * this schema lived in the universal model; it is household vocabulary.
 */
import { z } from "zod";
import { EvidenceSchema, SourceTypeSchema, SubjectIdSchema, unitInterval } from "@/types";

/* ------------------------------------------------------------------ */
/* Income sources (household pack; was universal until schema v5)      */
/* ------------------------------------------------------------------ */

export const IncomeSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Who in the household earns it (free text label, kept for display). */
  earner: z.string().default(""),
  /** The member who earns it; null = not yet attributed. */
  earnerId: SubjectIdSchema.nullable().default(null),
  monthlyAmount: z.number().min(0),
  /** Fraction of monthlyAmount that can be counted on in a bad month. */
  reliability: unitInterval,
  /** Month-to-month variability, 0 = fixed salary, 1 = fully unpredictable. */
  volatility: unitInterval,
  /** Sources sharing a group are assumed to fail together
   *  (same employer, same platform, same local industry). */
  correlationGroup: z.string().min(1),
  /** Months needed to replace this source if it disappears. */
  replacementLatencyMonths: z.number().min(0),
  sourceType: SourceTypeSchema,
  confidence: unitInterval,
  evidence: z.array(EvidenceSchema).default([]),
  notes: z.string().default(""),
});
export type IncomeSource = z.infer<typeof IncomeSourceSchema>;

export const INCOME_SOURCES = "incomeSources";
