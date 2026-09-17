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

/** Where a piece of evidence was read from, when a collector (a research
 *  agent, an import) brought it in. The source's own version marker is kept
 *  so a later change to the source can be told from the version reviewed. */
export const EvidenceSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().optional(),
  /** The source's version at retrieval: an etag, a content hash, a publication date. */
  version: z.string().min(1),
  /** ISO instant the source was retrieved. */
  retrievedAt: z.string().min(1),
  /** Where inside the source: a row key, a page, an anchor. */
  locator: z.string().optional(),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z.object({
  text: z.string().min(1),
  sourceType: SourceTypeSchema.default("self_reported"),
  /** ISO date the evidence was recorded, if known. */
  recordedAt: z.string().optional(),
  /** Structured origin for collected evidence (Step 7B); absent for hand-typed evidence. */
  source: EvidenceSourceSchema.optional(),
  /** The period the supporting content applies to, in the source's own words. */
  period: z.string().optional(),
  /** The exact supporting content, verbatim. */
  quote: z.string().optional(),
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

/** A member id or the system id. null on an entity means UNASSIGNED:
 *  nobody has said whose it is. Unassigned is never read as "household". */
export const SubjectIdSchema = z.string().min(1);
export type SubjectId = z.infer<typeof SubjectIdSchema>;

/**
 * Structured time reference. The person's original wording is always kept;
 * start/end are what the app could parse or what the person set, with an
 * explicit precision. "unknown" carries text only.
 */
export const TemporalPrecisionSchema = z.enum(["datetime", "day", "month", "year", "unspecified"]);
export type TemporalPrecision = z.infer<typeof TemporalPrecisionSchema>;

export const TemporalRefSchema = z
  .object({
    kind: z.enum(["instant", "date", "range", "approx", "unknown"]),
    /** ISO 8601 (date or datetime). Required for instant/date/range/approx. */
    start: z.string().optional(),
    /** ISO 8601. Required for range; optional for approx (end of the period). */
    end: z.string().optional(),
    precision: TemporalPrecisionSchema.default("unspecified"),
    /** The words as entered, e.g. "spring 2022", "around March", "ongoing". */
    text: z.string().default(""),
  })
  .superRefine((t, ctx) => {
    const needsStart = t.kind === "instant" || t.kind === "date" || t.kind === "range" || t.kind === "approx";
    if (needsStart && !t.start) ctx.addIssue({ code: "custom", message: `${t.kind} needs a start` });
    if (t.kind === "range" && !t.end) ctx.addIssue({ code: "custom", message: "range needs an end" });
    if (t.kind === "unknown" && (t.start || t.end)) ctx.addIssue({ code: "custom", message: "unknown carries no dates" });
    if (t.start && t.end && t.end < t.start) ctx.addIssue({ code: "custom", message: "end precedes start" });
  });
export type TemporalRef = z.infer<typeof TemporalRefSchema>;
