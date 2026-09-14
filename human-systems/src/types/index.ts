/**
 * Data model for the human-systems analysis tool.
 *
 * Everything here is a Zod schema plus its inferred TypeScript type so that
 * persisted data (localStorage today, a database later) and AI output can be
 * validated at the boundary instead of trusted.
 *
 * Design rules encoded in this file:
 *  - A variable is either an INPUT (a value someone entered, with provenance)
 *    or DERIVED (recomputed from inputs by a named formula and never edited).
 *  - Every value carries sourceType + confidence + evidence, so subjective
 *    judgments can never be mistaken for measurements.
 *  - The model layer knows nothing about React or the browser.
 */
import { z } from "zod";
import {
  EdgeDirectionSchema,
  EvidenceSchema,
  LagSchema,
  SourceTypeSchema,
  TargetModeSchema,
  unitInterval,
} from "./primitives";

import { StructuralSignatureSchema } from "./signature";

export * from "./primitives";
export * from "./signature";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** System types. Only individual + household are implemented in the MVP;
 *  the others exist so the schema does not need to change later. */
export const SystemTypeSchema = z.enum([
  "individual",
  "household",
  "organization",
  "country",
]);
export type SystemType = z.infer<typeof SystemTypeSchema>;

/** The ten distinctions from the working concept, collapsed into a
 *  category enum. `changeSpeed` carries the fast/slow distinction
 *  separately because any category can move fast or slow. */
export const VariableCategorySchema = z.enum([
  "event", // fast-changing visible state
  "structure", // slow-changing structural condition
  "constraint", // limits the action space
  "dependency", // single point of failure / fragility
  "buffer", // reserve, redundancy, slack
  "person_fit", // values, preferences, physical feasibility
  "agency", // execution, persistence, readiness
  "shock", // external event
  "asset", // productive asset / career capital that compounds
]);
export type VariableCategory = z.infer<typeof VariableCategorySchema>;

export const ChangeSpeedSchema = z.enum(["fast", "slow"]);
export type ChangeSpeed = z.infer<typeof ChangeSpeedSchema>;

export const VariableKindSchema = z.enum(["input", "derived"]);
export type VariableKind = z.infer<typeof VariableKindSchema>;

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

export const ReferenceRangeSchema = z
  .object({ min: z.number(), max: z.number() })
  .refine((r) => r.max > r.min, { message: "max must exceed min" });
export type ReferenceRange = z.infer<typeof ReferenceRangeSchema>;

export const VariableSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category: VariableCategorySchema,
  changeSpeed: ChangeSpeedSchema,
  /** input = entered by a person; derived = recomputed by a formula. */
  kind: VariableKindSchema.default("input"),
  /** Present only for derived variables: the formula id in model/derived.ts. */
  formulaId: z.string().optional(),
  currentValue: z.number().nullable(),
  desiredValue: z.number().nullable(),
  targetMode: TargetModeSchema.default("exact"),
  unit: z.string(),
  sourceType: SourceTypeSchema,
  /** 0..1 confidence in currentValue. Derived variables inherit the
   *  minimum confidence of their inputs. */
  confidence: unitInterval,
  evidence: z.array(EvidenceSchema).default([]),
  /** Leverage factors, all 0..1 ordinal judgments (see calculations/leverage). */
  controllability: unitInterval,
  durability: unitInterval,
  estimatedCostToChange: unitInterval,
  /** Optional judgment of how much moving this variable would close the
   *  structural gap. Leverage is only computed when it is present. */
  impact: unitInterval.optional(),
  /** Optional judgment of how uncertain the EFFECT of changing it is.
   *  Defaults to (1 - confidence) when absent. */
  effectUncertainty: unitInterval.optional(),
  /** Plausible band used to normalise gaps across different units. */
  referenceRange: ReferenceRangeSchema.optional(),
  notes: z.string().default(""),
});
export type Variable = z.infer<typeof VariableSchema>;

/* ------------------------------------------------------------------ */
/* Income sources                                                      */
/* ------------------------------------------------------------------ */

export const IncomeSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Who in the household earns it (free text, e.g. "Adult 1"). */
  earner: z.string().default(""),
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

/* ------------------------------------------------------------------ */
/* Relationships (directed edges)                                      */
/* ------------------------------------------------------------------ */

export const RelationshipSchema = z.object({
  id: z.string().min(1),
  sourceVariableId: z.string().min(1),
  targetVariableId: z.string().min(1),
  /** positive: source up -> target up. negative: source up -> target down. */
  direction: EdgeDirectionSchema,
  /** 0..1 MODEL JUDGMENT of influence. NOT an empirically estimated causal
   *  coefficient; nothing in this application estimates one. */
  strength: unitInterval,
  lag: LagSchema,
  confidence: unitInterval,
  sourceType: SourceTypeSchema,
  evidence: z.array(EvidenceSchema).default([]),
  explanation: z.string().default(""),
  notes: z.string().default(""),
  /** Disabled edges are kept for the record but excluded from loops,
   *  propagation and influence. */
  enabled: z.boolean().default(true),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/** Optional human labelling of a detected loop, keyed by the loop's
 *  canonical id (see calculations/graph). */
export const LoopAnnotationSchema = z.object({
  name: z.string(),
  notes: z.string().default(""),
});
export type LoopAnnotation = z.infer<typeof LoopAnnotationSchema>;

/* ------------------------------------------------------------------ */
/* Constraints, actions, person fit                                    */
/* ------------------------------------------------------------------ */

export const ConstraintTypeSchema = z.enum(["hard", "soft"]);
export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;

export const ConstraintComparatorSchema = z.enum(["lte", "gte", "eq"]);

/** Optional machine-checkable rule: a limit on a requirement dimension.
 *  An action declares its requirements on the same dimension keys. A
 *  constraint without a check is descriptive only and is listed as
 *  "unchecked" for every action. */
export const ConstraintCheckSchema = z.object({
  /** e.g. "hoursPerWeek", "capitalRequired", "requiresRelocation",
   *  "requiresDriving", "requiresLicense", "physicalDemand". */
  dimension: z.string().min(1),
  comparator: ConstraintComparatorSchema,
  limit: z.union([z.number(), z.boolean()]),
});
export type ConstraintCheck = z.infer<typeof ConstraintCheckSchema>;

export const ConstraintSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  /** hard: a violation makes an action infeasible.
   *  soft: a violation lowers suitability but never excludes. */
  type: ConstraintTypeSchema,
  check: ConstraintCheckSchema.optional(),
  /** Soft constraints only: how much a violation lowers suitability (0..1). */
  softPenalty: unitInterval.default(0.5),
  sourceType: SourceTypeSchema,
  confidence: unitInterval,
  evidence: z.array(EvidenceSchema).default([]),
  /** The person has read and confirmed this constraint applies to them. */
  userConfirmed: z.boolean().default(false),
  notes: z.string().default(""),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const UtilityDimensionSchema = z.enum([
  "financialImprovement",
  "stability",
  "upside",
  "physicalFit",
  "personalityFit",
  "valuesFit",
  "autonomy",
  "scheduleFit",
  "stress",
  "timeRequirement",
  "risk",
  "reversibility",
  "careerCompounding",
  "assetCompounding",
]);
export type UtilityDimension = z.infer<typeof UtilityDimensionSchema>;

/** -1..1 per dimension: negative = the action makes this worse. */
export const UtilityVectorSchema = z.partialRecord(
  UtilityDimensionSchema,
  z.number().min(-1).max(1),
);
export type UtilityVector = z.infer<typeof UtilityVectorSchema>;

/** Optional priorities. Absent = unweighted view only. */
export const UtilityWeightsSchema = z.partialRecord(
  UtilityDimensionSchema,
  z.number().min(0).max(1),
);
export type UtilityWeights = z.infer<typeof UtilityWeightsSchema>;

export const ActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  /** Variables this action is intended to move. */
  targetVariables: z.array(z.string()).default([]),
  /** Requirement per constraint dimension. */
  requirements: z.record(z.string(), z.union([z.number(), z.boolean()])),
  utility: UtilityVectorSchema.default({}),
  /** Leverage factors (0..1 ordinal judgments). */
  impact: unitInterval,
  controllability: unitInterval,
  durability: unitInterval,
  cost: unitInterval,
  uncertainty: unitInterval,
  sourceType: SourceTypeSchema,
  confidence: unitInterval,
  notes: z.string().default(""),
});
export type Action = z.infer<typeof ActionSchema>;

/* ------------------------------------------------------------------ */
/* Observations and hypotheses                                         */
/* ------------------------------------------------------------------ */

/** Which model entities an observation is linked to. Linking never turns
 *  the observation into a value; it records "this observation bears on". */
export const ObservationLinksSchema = z.object({
  variableIds: z.array(z.string()).default([]),
  relationshipIds: z.array(z.string()).default([]),
  constraintIds: z.array(z.string()).default([]),
  hypothesisIds: z.array(z.string()).default([]),
});
export type ObservationLinks = z.infer<typeof ObservationLinksSchema>;

/** An OBSERVATION: something noticed or reported, kept verbatim. It is not
 *  a variable, not a relationship, and carries no interpretation. */
export const ObservationSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  /** Free text: "2019-2021", "March 2026", "ongoing". */
  dateOrPeriod: z.string().default(""),
  /** A member id from the profile, or the system id for the whole system. */
  subjectId: z.string().default(""),
  sourceType: SourceTypeSchema,
  confidence: unitInterval,
  /** Where it came from: "bank statements", "conversation 2026-09-01". */
  evidenceSource: z.string().default(""),
  notes: z.string().default(""),
  links: ObservationLinksSchema.prefault({}),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const HypothesisStatusSchema = z.enum(["proposed", "accepted", "rejected", "uncertain"]);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const HypothesisKindSchema = z.enum(["loop", "relationship", "general"]);
export type HypothesisKind = z.infer<typeof HypothesisKindSchema>;

/** An INTERPRETATION under review. "accepted" means the person accepts it
 *  as a working reading of their system, never that it is proven. */
export const HypothesisSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  kind: HypothesisKindSchema.default("general"),
  /** For kind "loop": the canonical loop id (calculations/graph). */
  loopId: z.string().optional(),
  /** Relationships this hypothesis is about. */
  relationshipIds: z.array(z.string()).default([]),
  supportingObservationIds: z.array(z.string()).default([]),
  contradictingObservationIds: z.array(z.string()).default([]),
  confidence: unitInterval,
  status: HypothesisStatusSchema.default("proposed"),
  notes: z.string().default(""),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

/* ------------------------------------------------------------------ */
/* Attractor descriptions                                              */
/* ------------------------------------------------------------------ */

/** Qualitative description of the recurring state. The numeric side of
 *  "current" lives in the variables' currentValue; the numeric side of
 *  "desired" lives in desiredValue. */
export const AttractorDescriptionSchema = z.object({
  summary: z.string().default(""),
  /** Recurring outcomes the person keeps returning to (or wants). */
  recurringOutcomes: z.array(z.string()).default([]),
  sourceType: SourceTypeSchema.default("self_reported"),
  confidence: unitInterval.default(0.5),
});
export type AttractorDescription = z.infer<typeof AttractorDescriptionSchema>;

/* ------------------------------------------------------------------ */
/* System profile + aggregate                                          */
/* ------------------------------------------------------------------ */

export const MemberSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  role: z.string().default(""),
});
export type Member = z.infer<typeof MemberSchema>;

export const SystemProfileSchema = z.object({
  name: z.string().min(1),
  systemType: SystemTypeSchema,
  description: z.string().default(""),
  members: z.array(MemberSchema).default([]),
  location: z.string().default(""),
  currency: z.string().default("USD"),
});
export type SystemProfile = z.infer<typeof SystemProfileSchema>;

/** Bump when the stored shape changes; add a step in model/migrations. */
export const MODEL_SCHEMA_VERSION = 2;

export const SystemModelSchema = z.object({
  schemaVersion: z.literal(MODEL_SCHEMA_VERSION),
  id: z.string().min(1),
  profile: SystemProfileSchema,
  variables: z.array(VariableSchema),
  incomeSources: z.array(IncomeSourceSchema),
  relationships: z.array(RelationshipSchema),
  loopAnnotations: z.record(z.string(), LoopAnnotationSchema).default({}),
  constraints: z.array(ConstraintSchema).default([]),
  actions: z.array(ActionSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  hypotheses: z.array(HypothesisSchema).default([]),
  /** Immutable structural-signature snapshots (see types/signature). */
  signatures: z.array(StructuralSignatureSchema).default([]),
  /** Which signature definition this system uses. */
  signatureDefinitionId: z.string().default("household_default"),
  utilityWeights: UtilityWeightsSchema.optional(),
  currentAttractor: AttractorDescriptionSchema.prefault({}),
  desiredAttractor: AttractorDescriptionSchema.prefault({}),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
});
export type SystemModel = z.infer<typeof SystemModelSchema>;

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

export const ScenarioChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setVariable"), variableId: z.string(), value: z.number() }),
  z.object({ kind: z.literal("adjustVariable"), variableId: z.string(), delta: z.number() }),
  z.object({
    kind: z.literal("setIncomeSourceAmount"),
    incomeSourceId: z.string(),
    monthlyAmount: z.number().min(0),
  }),
  z.object({ kind: z.literal("addIncomeSource"), source: IncomeSourceSchema }),
  z.object({ kind: z.literal("removeIncomeSource"), incomeSourceId: z.string() }),
]);
export type ScenarioChange = z.infer<typeof ScenarioChangeSchema>;

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  changes: z.array(ScenarioChangeSchema),
  /** Horizon for the compounding projections. */
  horizonMonths: z.number().int().min(1).max(240).default(24),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
