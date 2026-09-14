/**
 * Primitive schemas shared by the model (types/index.ts) and the
 * structural-signature types (types/signature.ts). Kept separate so the
 * two modules never import each other.
 */
import { z } from "zod";

export const unitInterval = z.number().min(0).max(1);

export const SourceTypeSchema = z.enum([
  "measured",
  "calculated",
  "self_reported",
  "observed",
  "estimated", // analyst's rough estimate, not stated by the person
  "ai_inferred",
  "unknown",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** How desiredValue is meant: a floor, a ceiling, or an exact point.
 *  Overshooting a floor or undershooting a ceiling closes the gap. */
export const TargetModeSchema = z.enum(["at_least", "at_most", "exact"]);
export type TargetMode = z.infer<typeof TargetModeSchema>;

export const EvidenceSchema = z.object({
  text: z.string().min(1),
  sourceType: SourceTypeSchema.default("self_reported"),
  /** ISO date the evidence was recorded, if known. */
  recordedAt: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const LagUnitSchema = z.enum(["days", "weeks", "months", "years"]);
export type LagUnit = z.infer<typeof LagUnitSchema>;

/** Delay before an effect shows. Stored in the unit the person thinks in;
 *  converted only for arithmetic (calculations/lag). */
export const LagSchema = z.object({
  value: z.number().min(0),
  unit: LagUnitSchema,
});
export type Lag = z.infer<typeof LagSchema>;

export const EdgeDirectionSchema = z.enum(["positive", "negative"]);
export type EdgeDirection = z.infer<typeof EdgeDirectionSchema>;
