/**
 * Structural signatures: a compact, DERIVED representation of the
 * persistent structural state of a system at one moment.
 *
 *   Sigma(t) = (V(t), R(t), C(t), M(t))
 *
 *   V = normalized state vector      -> dimensions[].normalizedValue
 *   R = relationship / loop structure -> relationshipSnapshot, loopSnapshot
 *   C = confidence vector             -> dimensions[].confidence
 *   M = missing-information mask      -> dimensions[].state === "unknown"
 *
 * Nothing here is typed by a person. A signature is computed by
 * signatures/compute.ts from the evaluated model and stored immutably.
 * Binary and band classifications are DISPLAY conveniences derived from
 * the continuous value; they are never the canonical representation.
 */
import { z } from "zod";
import { EdgeDirectionSchema, LagSchema, SourceTypeSchema, SubjectIdSchema, TargetModeSchema, unitInterval } from "./primitives";

/* ------------------------------------------------------------------ */
/* Definitions (how a signature is computed)                           */
/* ------------------------------------------------------------------ */

/** How one contributing variable's raw value maps to 0..1. */
export const InputTransformSchema = z.discriminatedUnion("kind", [
  /** (value - min) / (max - min), clipped to 0..1. */
  z.object({ kind: z.literal("linear"), min: z.number(), max: z.number() }),
  /** value / strongAt, clipped to 0..1 (e.g. floor ratio with strongAt 1.5). */
  z.object({ kind: z.literal("ratio"), strongAt: z.number().positive() }),
]);
export type InputTransform = z.infer<typeof InputTransformSchema>;

export const DimensionInputSchema = z.object({
  /** Definition key, resolved for the signature's subject (or the system
   *  for system-scope dimensions). */
  variableKey: z.string().min(1),
  transform: InputTransformSchema,
  /** true when a HIGHER raw value means a WEAKER structural position
   *  (e.g. income concentration); the normalized value is 1 - t(value). */
  invert: z.boolean().default(false),
  weight: z.number().positive().default(1),
  /** A required input that is unknown makes the whole dimension unknown. */
  required: z.boolean().default(false),
  /** The question to ask when this input is missing or poorly evidenced. */
  question: z.string().min(1),
});
export type DimensionInput = z.infer<typeof DimensionInputSchema>;

export const AggregationSchema = z.enum(["weighted_mean", "min", "max"]);
export const ConfidenceMethodSchema = z.enum(["weighted_mean", "min"]);

/** Five ascending cut points are not needed: four boundaries split 0..1
 *  into very_weak | weak | mixed | strong | very_strong. */
export const BandThresholdsSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((t) => t[0] < t[1] && t[1] < t[2] && t[2] < t[3], { message: "band thresholds must ascend" });

export const SignatureDimensionDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  explanation: z.string().min(1),
  /** "higher" = a larger normalized value is the structurally stronger
   *  position. Inputs already encode their own direction via `invert`;
   *  this is the reading of the dimension as a whole. */
  targetDirection: z.enum(["higher"]).default("higher"),
  /** system: reads household keys; member: reads the subject member's keys. */
  subjectScope: z.enum(["system", "member"]).default("system"),
  inputs: z.array(DimensionInputSchema).min(1),
  aggregation: AggregationSchema.default("weighted_mean"),
  /** Minimum number of KNOWN inputs before a value is computed at all. */
  minimumKnownInputs: z.number().int().min(1).default(1),
  confidenceMethod: ConfidenceMethodSchema.default("weighted_mean"),
  /** normalizedValue >= binaryThreshold -> "strong" in the compact strip. */
  binaryThreshold: unitInterval.default(0.5),
  bandThresholds: BandThresholdsSchema.default([0.2, 0.4, 0.6, 0.8]),
  /** 0..1 weight used ONLY by the question-priority heuristic. */
  importance: unitInterval.default(0.7),
});
export type SignatureDimensionDefinition = z.infer<typeof SignatureDimensionDefinitionSchema>;

export const SignatureDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Which system types this definition is meant for. */
  domain: z.enum(["individual", "household", "organization", "country"]),
  version: z.number().int().min(1),
  /** experimental: thresholds and weights are unreviewed conventions. */
  maturity: z.enum(["experimental", "reviewed"]).default("experimental"),
  description: z.string().default(""),
  dimensions: z.array(SignatureDimensionDefinitionSchema).min(1),
});
export type SignatureDefinition = z.infer<typeof SignatureDefinitionSchema>;

/* ------------------------------------------------------------------ */
/* Snapshots (what a computed signature stores)                        */
/* ------------------------------------------------------------------ */

export const DimensionStateSchema = z.enum(["known", "unknown"]);
export const BinaryStateSchema = z.enum(["weak", "strong", "unknown"]);
export const BandStateSchema = z.enum(["very_weak", "weak", "mixed", "strong", "very_strong", "unknown"]);
export type BinaryState = z.infer<typeof BinaryStateSchema>;
export type BandState = z.infer<typeof BandStateSchema>;

/** Provenance of one contributing variable at snapshot time. */
export const ContributionSchema = z.object({
  /** The variable that was resolved for this input (null when none exists). */
  variableId: z.string().nullable(),
  variableKey: z.string(),
  name: z.string(),
  unit: z.string(),
  /** Raw value used (null = unknown; NEVER substituted with 0). */
  rawValue: z.number().nullable(),
  /** 0..1 after transform and inversion; null when raw is unknown. */
  normalized: unitInterval.nullable(),
  weight: z.number(),
  required: z.boolean(),
  sourceType: SourceTypeSchema.nullable(),
  confidence: z.number().nullable(),
  /** Evidence texts recorded on the variable itself. */
  evidenceTexts: z.array(z.string()).default([]),
  /** Observations linked to this variable. */
  observationIds: z.array(z.string()).default([]),
  transform: InputTransformSchema,
  invert: z.boolean(),
});
export type Contribution = z.infer<typeof ContributionSchema>;

export const StructuralDimensionSnapshotSchema = z.object({
  dimensionId: z.string(),
  name: z.string(),
  state: DimensionStateSchema,
  /** Canonical value, 0..1. null exactly when state is "unknown". */
  normalizedValue: unitInterval.nullable(),
  binaryState: BinaryStateSchema,
  bandState: BandStateSchema,
  /** 0 when unknown. */
  confidence: unitInterval,
  /** Share of input weight that was known (0..1). */
  knownWeightFraction: unitInterval,
  contributingVariableIds: z.array(z.string()),
  contributions: z.array(ContributionSchema),
  /** Every observation linked to any contributing variable. */
  evidenceIds: z.array(z.string()),
  calculationMethod: z.string(),
  explanation: z.string(),
  /** Variable ids (or names when absent from the model) that were unknown. */
  missingInformation: z.array(z.string()),
  binaryThreshold: z.number(),
  bandThresholds: BandThresholdsSchema,
  assumptionIds: z.array(z.string()).default([]),
});
export type StructuralDimensionSnapshot = z.infer<typeof StructuralDimensionSnapshotSchema>;

/** Compact copy of one edge as it stood at snapshot time. */
export const RelationshipSnapshotItemSchema = z.object({
  id: z.string(),
  sourceVariableId: z.string(),
  targetVariableId: z.string(),
  sourceName: z.string(),
  targetName: z.string(),
  direction: EdgeDirectionSchema,
  strength: z.number(),
  lag: LagSchema,
  confidence: z.number(),
  sourceType: SourceTypeSchema,
  enabled: z.boolean(),
});
export type RelationshipSnapshotItem = z.infer<typeof RelationshipSnapshotItemSchema>;

export const LoopSnapshotItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  polarity: z.enum(["reinforcing", "balancing"]),
  variableIds: z.array(z.string()),
  meanStrength: z.number(),
  pressure: z.number().nullable(),
  cycleTimeMonths: z.number(),
  status: z.enum(["proposed", "accepted", "rejected", "uncertain"]),
  minConfidence: z.number(),
});
export type LoopSnapshotItem = z.infer<typeof LoopSnapshotItemSchema>;

/** Every variable's value at snapshot time, so history can be inspected
 *  below the dimension level (persistence indicators, "what changed"). */
export const VariableSnapshotItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string(),
  kind: z.enum(["input", "derived"]),
  category: z.string(),
  changeSpeed: z.enum(["fast", "slow"]),
  currentValue: z.number().nullable(),
  desiredValue: z.number().nullable(),
  targetMode: TargetModeSchema,
  /** 0..1 position inside referenceRange when one exists. */
  normalized: unitInterval.nullable(),
  confidence: z.number(),
  sourceType: SourceTypeSchema,
});
export type VariableSnapshotItem = z.infer<typeof VariableSnapshotItemSchema>;

/** The dynamics half of the signature: derived from R(t), never binary. */
export const DynamicsSignatureSchema = z.object({
  strongestReinforcingLoops: z.array(LoopSnapshotItemSchema),
  strongestBalancingLoops: z.array(LoopSnapshotItemSchema),
  /** Variables ranked by combined in- and out-influence. */
  highCentralityVariables: z.array(
    z.object({ variableId: z.string(), name: z.string(), outInfluence: z.number(), inInfluence: z.number(), centrality: z.number() }),
  ),
  strongestIncomingInfluences: z.array(RelationshipSnapshotItemSchema),
  strongestOutgoingInfluences: z.array(RelationshipSnapshotItemSchema),
  /** Slowest edges: where effects take longest to show. */
  importantLags: z.array(RelationshipSnapshotItemSchema),
  relationshipConfidence: z.object({
    count: z.number(),
    mean: z.number().nullable(),
    min: z.number().nullable(),
    /** Share of edges whose sourceType is measured or calculated. */
    evidencedShare: z.number().nullable(),
  }),
  loopCounts: z.object({ reinforcing: z.number(), balancing: z.number(), accepted: z.number(), rejected: z.number() }),
});
export type DynamicsSignature = z.infer<typeof DynamicsSignatureSchema>;

export const SIGNATURE_SCHEMA_VERSION = 1;

export const StructuralSignatureSchema = z.object({
  id: z.string().min(1),
  systemId: z.string().min(1),
  /** The subject this signature describes: the system id or a member id. */
  subjectId: SubjectIdSchema,
  createdAt: z.string(),
  /** The instant values and targets were resolved at. null = the clock at
   *  creation; a past instant marks an as-of reconstruction under the
   *  structure of createdAt (relationships are not versioned). */
  valuesAsOf: z.string().nullable().optional(),
  schemaVersion: z.literal(SIGNATURE_SCHEMA_VERSION),
  /** Which definition (and version) produced it. */
  definitionId: z.string(),
  definitionVersion: z.number().int(),
  /** "current" reads currentValue; "desired" reads desiredValue (with
   *  targetMode honoured: a floor already met keeps the current value). */
  mode: z.enum(["current", "desired"]),
  dimensions: z.array(StructuralDimensionSnapshotSchema),
  relationshipSnapshot: z.array(RelationshipSnapshotItemSchema),
  loopSnapshot: z.array(LoopSnapshotItemSchema),
  variableSnapshot: z.array(VariableSnapshotItemSchema),
  dynamics: DynamicsSignatureSchema,
  /** Share of dimensions that are known. */
  completeness: unitInterval,
  /** Mean confidence over KNOWN dimensions; null when nothing is known. */
  overallConfidence: z.number().nullable(),
  /** Every observation linked to any contributing variable. */
  sourceObservationIds: z.array(z.string()),
  /** Compact strip: one character per dimension, "1" strong, "0" weak,
   *  "?" unknown. Display only. */
  compactStrip: z.string(),
  label: z.string().optional(),
  notes: z.string().optional(),
});
export type StructuralSignature = z.infer<typeof StructuralSignatureSchema>;
