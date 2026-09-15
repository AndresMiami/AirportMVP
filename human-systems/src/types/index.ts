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
  type SourceType,
  SubjectIdSchema,
  TargetModeSchema,
  TemporalRefSchema,
  unitInterval,
} from "./primitives";

import { StructuralSignatureSchema } from "./signature";

export * from "./primitives";
export * from "./signature";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** The KIND of system, as a human-readable label ("household", "market",
 *  "ecosystem"). The engine never interprets it; the domain pack may
 *  suggest values for a picker. Engine identity is the domain definition
 *  (domainDefinitionId + version), not this label. */
export const SystemTypeSchema = z.string().min(1);
export type SystemType = z.infer<typeof SystemTypeSchema>;

/** Variable category: a vocabulary word, never an engine mechanic (no
 *  calculation branches on it). The engine ships the generic categories
 *  below; a domain pack may add its own (e.g. the household pack adds
 *  person_fit and agency). Stored values are validated against the active
 *  domain's vocabulary on NEW writes only; historical values are kept. */
export const GENERIC_CATEGORIES = [
  "event", // fast-changing visible state
  "structure", // slow-changing structural condition
  "constraint", // limits the action space
  "dependency", // single point of failure / fragility
  "buffer", // reserve, redundancy, slack
  "shock", // external event
  "asset", // something that accumulates or compounds
] as const;
export const VariableCategorySchema = z.string().min(1);
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

/* ---- Value and target history (schema v4) ---------------------------
 * The stored truth for an INPUT variable is its append-only history of
 * value entries; the stored truth for any variable's goal is its history
 * of target entries. "Current value" and "current target" are VIEWS
 * resolved by model/history.ts at a clock instant. Five clocks stay
 * apart: `recordedAt` (when the app recorded the entry), `valid` (when the
 * value is asserted to apply), `observed` (when it was observed, if that
 * differs), an event's `occurred`, a snapshot's `createdAt`/`valuesAsOf`,
 * and a relationship's lag. None is ever substituted for another.
 * -------------------------------------------------------------------- */

/** Where `valid` came from: the person asserted when the value applied,
 *  or the app only knows when it was recorded and uses that instant as the
 *  earliest defensible time (never earlier). */
export const ValidBasisSchema = z.enum(["asserted", "recorded"]);
export type ValidBasis = z.infer<typeof ValidBasisSchema>;

/** active = counts for resolution; superseded = replaced by a correction
 *  (the correcting entry names it); retracted = withdrawn by the person.
 *  Nothing is ever deleted from a history. */
export const HistoryEntryStatusSchema = z.enum(["active", "superseded", "retracted"]);
export type HistoryEntryStatus = z.infer<typeof HistoryEntryStatusSchema>;

export const ValueRangeSchema = z.object({ low: z.number(), high: z.number() }).refine((r) => r.high >= r.low, { message: "high must be at least low" });

export const ValueEntrySchema = z.object({
  id: z.string().min(1),
  /** null = the person recorded that the value is unknown at this time. */
  value: z.number().nullable(),
  /** Optional range the evidence supports (seam; not yet used by formulas). */
  range: ValueRangeSchema.optional(),
  /** When the value is asserted to apply. Approximate or unknown time is
   *  preserved as such and never turned into an exact date. */
  valid: TemporalRefSchema,
  validBasis: ValidBasisSchema,
  /** When it was observed, if that differs from when it applied. */
  observed: TemporalRefSchema.optional(),
  /** When the app recorded this entry (ISO instant). */
  recordedAt: z.string().min(1),
  sourceType: SourceTypeSchema,
  confidence: unitInterval,
  evidence: z.array(EvidenceSchema).default([]),
  observationIds: z.array(z.string()).default([]),
  note: z.string().default(""),
  status: HistoryEntryStatusSchema.default("active"),
  /** Set on a correcting entry: the entry it replaces. */
  supersedesId: z.string().optional(),
  retractedAt: z.string().optional(),
  retractReason: z.string().optional(),
});
export type ValueEntry = z.infer<typeof ValueEntrySchema>;

export const TargetEntrySchema = z.object({
  id: z.string().min(1),
  /** null = the target was cleared from this time on. */
  desiredValue: z.number().nullable(),
  targetMode: TargetModeSchema,
  valid: TemporalRefSchema,
  validBasis: ValidBasisSchema,
  recordedAt: z.string().min(1),
  note: z.string().default(""),
  status: HistoryEntryStatusSchema.default("active"),
  supersedesId: z.string().optional(),
  retractedAt: z.string().optional(),
  retractReason: z.string().optional(),
});
export type TargetEntry = z.infer<typeof TargetEntrySchema>;

/** The STORED variable record. No current value, no current target, no
 *  provenance of its own: those are views over `values` / `targets`. A
 *  derived variable is a SHELL here (notes, targets, judgments) and never
 *  carries value entries; its value is always recomputed. */
export const VariableSchema = z.object({
  id: z.string().min(1),
  /** Definition key inside the active domain (e.g. "career_capital").
   *  Ids stay globally unique; keys are resolved per subject. */
  key: z.string().min(1),
  /** Whose variable this is. null = UNASSIGNED (never the whole system). */
  subjectId: SubjectIdSchema.nullable(),
  name: z.string().min(1),
  description: z.string().default(""),
  category: VariableCategorySchema,
  changeSpeed: ChangeSpeedSchema,
  /** input = entered by a person; derived = recomputed by a formula. */
  kind: VariableKindSchema.default("input"),
  /** Present only for derived variables: the formula id in model/derived.ts. */
  formulaId: z.string().optional(),
  /** Append-only value history (inputs only; always empty on a derived shell). */
  values: z.array(ValueEntrySchema).default([]),
  /** Append-only target history. */
  targets: z.array(TargetEntrySchema).default([]),
  /** Default target mode for new targets and when no target entry exists. */
  targetMode: TargetModeSchema.default("exact"),
  unit: z.string(),
  /** Variable-level evidence kept from before v4; new evidence attaches to entries. */
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
}).superRefine((v, ctx) => {
  if (v.kind === "derived" && v.values.length > 0) {
    ctx.addIssue({ code: "custom", path: ["values"], message: "a calculated variable never stores value entries; its value is recomputed" });
  }
  const ids = new Set<string>();
  for (const e of [...v.values, ...v.targets]) {
    if (ids.has(e.id)) ctx.addIssue({ code: "custom", path: ["values"], message: `duplicate history entry id "${e.id}"` });
    ids.add(e.id);
  }
});
export type StoredVariable = z.infer<typeof VariableSchema>;

/** How a current value / target was resolved from its history. */
export const HistoryResolutionStateSchema = z.enum([
  "resolved", // one active, orderable entry applies at the instant
  "no_entries", // nothing recorded
  "before_first", // the instant is earlier than every orderable entry: unknown, never the later value
  "unorderable_only", // only entries without an orderable time exist: preserved, not used
  "ambiguous", // two active entries start at the same time with different values
]);
export type HistoryResolutionState = z.infer<typeof HistoryResolutionStateSchema>;

/** The resolved VIEW of a variable at a clock instant. This is what every
 *  calculation, screen and signature reads. currentValue / desiredValue /
 *  sourceType / confidence are never stored; they come from the entry
 *  that applies (or, for a derived variable, from the formula). */
export type Variable = StoredVariable & {
  currentValue: number | null;
  desiredValue: number | null;
  sourceType: SourceType;
  confidence: number;
  /** The entries the view rests on (null when none applies). */
  valueEntry: ValueEntry | null;
  targetEntry: TargetEntry | null;
  valueResolution: HistoryResolutionState;
  targetResolution: HistoryResolutionState;
};

/* ------------------------------------------------------------------ */
/* Income sources                                                      */
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

/* ------------------------------------------------------------------ */
/* Relationships (directed edges)                                      */
/* ------------------------------------------------------------------ */

/** What an arrow claims. Only causal hypotheses and (opted-in) definitional
 *  dependencies may take part in loops and propagation. Migration assigns
 *  "unclassified", never "causal_hypothesis": unknown kind ≠ causal. */
export const RelationshipKindSchema = z.enum([
  "unclassified",
  "causal_hypothesis",
  "association",
  "definitional",
  "constraint",
]);
export type RelationshipKind = z.infer<typeof RelationshipKindSchema>;

/** Kinds that MAY participate in dynamics (the person still opts in). */
export const DYNAMICS_ELIGIBLE_KINDS: readonly RelationshipKind[] = ["causal_hypothesis", "definitional"];

export const RelationshipSchema = z.object({
  id: z.string().min(1),
  sourceVariableId: z.string().min(1),
  targetVariableId: z.string().min(1),
  kind: RelationshipKindSchema,
  /** True only for eligible kinds; loops, propagation, influence and the
   *  dynamics signature read edges with enabled && participatesInDynamics. */
  participatesInDynamics: z.boolean(),
  hypothesisId: z.string().optional(),
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
}).superRefine((r, ctx) => {
  if (r.participatesInDynamics && !DYNAMICS_ELIGIBLE_KINDS.includes(r.kind)) {
    ctx.addIssue({ code: "custom", message: `a ${r.kind} relationship cannot participate in dynamics` });
  }
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
  /** Whose constraint. null = not yet attributed. */
  subjectId: SubjectIdSchema.nullable().default(null),
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

/** An option-evaluation dimension KEY. The engine knows only "a named
 *  dimension with a signed judgment"; the meaning of a key (e.g. the
 *  household pack's "scheduleFit") is declared by the domain pack. New
 *  writes are validated against the active domain's declared dimensions;
 *  historical values are preserved without being reinterpreted. */
export const UtilityDimensionSchema = z.string().min(1);
export type UtilityDimension = z.infer<typeof UtilityDimensionSchema>;

/** -1..1 per dimension: negative = the action makes this worse. */
export const UtilityVectorSchema = z.record(
  z.string().min(1),
  z.number().min(-1).max(1),
);
export type UtilityVector = z.infer<typeof UtilityVectorSchema>;

/** Optional priorities. Absent = unweighted view only. */
export const UtilityWeightsSchema = z.record(
  z.string().min(1),
  z.number().min(0).max(1),
);
export type UtilityWeights = z.infer<typeof UtilityWeightsSchema>;

/** Versioned envelope for domain-module data attached to a core entity.
 *  The core validates only the envelope and preserves the payload verbatim
 *  through every migration; the owning module validates and migrates it. */
export const ExtensionEnvelopeSchema = z.object({
  schemaVersion: z.number().int().min(1),
  payload: z.unknown(),
});
export type ExtensionEnvelope = z.infer<typeof ExtensionEnvelopeSchema>;
export const ExtensionsSchema = z.record(z.string(), ExtensionEnvelopeSchema);

export const ActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  /** Who would carry it out. null = not yet attributed. */
  subjectId: SubjectIdSchema.nullable().default(null),
  /** Variables this action is intended to move. */
  targetVariables: z.array(z.string()).default([]),
  /** Domain-module data by domain id (e.g. a future opportunity profile). */
  extensions: ExtensionsSchema.default({}),
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
export const HypothesisPredictionSchema = z.object({
  statement: z.string().min(1),
  variableId: z.string().optional(),
  expectedDirection: z.enum(["up", "down"]).optional(),
  by: TemporalRefSchema.optional(),
});
export type HypothesisPrediction = z.infer<typeof HypothesisPredictionSchema>;

export const HypothesisReviewEntrySchema = z.object({
  at: z.string(),
  status: HypothesisStatusSchema,
  note: z.string().default(""),
});
export type HypothesisReviewEntry = z.infer<typeof HypothesisReviewEntrySchema>;

/** A decision rule the PERSON set. The engine reports triggered / cleared
 *  against the named variable; it never changes a hypothesis status. */
export const KillCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  variableId: z.string().optional(),
  comparator: z.enum(["lt", "lte", "gt", "gte"]).optional(),
  threshold: z.number().optional(),
  status: z.enum(["open", "triggered", "cleared"]).default("open"),
  observationIds: z.array(z.string()).default([]),
});
export type KillCriterion = z.infer<typeof KillCriterionSchema>;

export const HypothesisSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  kind: HypothesisKindSchema.default("general"),
  /** Whose hypothesis, when it is about one person. null = not attributed. */
  subjectId: SubjectIdSchema.nullable().default(null),
  /** What evidence would weaken or change this hypothesis. */
  disconfirmingConditions: z.array(z.string()).default([]),
  predictions: z.array(HypothesisPredictionSchema).default([]),
  /** Every status change, with its reason. */
  reviewLog: z.array(HypothesisReviewEntrySchema).default([]),
  killCriteria: z.array(KillCriterionSchema).default([]),
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
/* Events, shocks, interventions                                       */
/* ------------------------------------------------------------------ */

export const EventKindSchema = z.enum(["shock", "change", "intervention", "outcome", "decision"]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const InterventionStatusSchema = z.enum(["planned", "in_progress", "done", "abandoned"]);

export const EventLinksSchema = z.object({
  variableIds: z.array(z.string()).default([]),
  relationshipIds: z.array(z.string()).default([]),
  hypothesisIds: z.array(z.string()).default([]),
  actionIds: z.array(z.string()).default([]),
  eventIds: z.array(z.string()).default([]),
  incomeSourceIds: z.array(z.string()).default([]),
});

/** A dated fact: something that happened, was changed, or was tried. It is
 *  never a numeric variable. */
export const EventSchema = z.object({
  id: z.string().min(1),
  kind: EventKindSchema,
  /** Domain vocabulary, e.g. job_lost, contract_lost, training_started. */
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  occurred: TemporalRefSchema,
  recordedAt: z.string(),
  subjectId: SubjectIdSchema.nullable().default(null),
  sourceType: SourceTypeSchema,
  confidence: unitInterval,
  observationIds: z.array(z.string()).default([]),
  links: EventLinksSchema.prefault({}),
  /** Interventions only. */
  status: InterventionStatusSchema.optional(),
  expected: z
    .array(z.object({ variableId: z.string(), direction: z.enum(["up", "down"]), by: TemporalRefSchema.optional() }))
    .default([]),
  outcomeEventIds: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type Event = z.infer<typeof EventSchema>;

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

/** A member's id is a stable historical subject id: it survives leaving the
 *  household. Members are archived, never silently erased. */
export const MemberSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  role: z.string().default(""),
  status: z.enum(["active", "archived"]).default("active"),
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
export const MODEL_SCHEMA_VERSION = 4;

export const SystemModelSchema = z.object({
  schemaVersion: z.literal(MODEL_SCHEMA_VERSION),
  id: z.string().min(1),
  /** Which domain definition (engine configuration) this system uses. */
  domainDefinitionId: z.string().min(1),
  domainDefinitionVersion: z.number().int().min(1),
  profile: SystemProfileSchema,
  variables: z.array(VariableSchema),
  incomeSources: z.array(IncomeSourceSchema),
  relationships: z.array(RelationshipSchema),
  events: z.array(EventSchema).default([]),
  loopAnnotations: z.record(z.string(), LoopAnnotationSchema).default({}),
  constraints: z.array(ConstraintSchema).default([]),
  actions: z.array(ActionSchema).default([]),
  observations: z.array(ObservationSchema).default([]),
  hypotheses: z.array(HypothesisSchema).default([]),
  /** Immutable structural-signature snapshots (see types/signature). */
  signatures: z.array(StructuralSignatureSchema).default([]),
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
