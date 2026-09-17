import { describe, expect, it } from "vitest";
import { registerBuiltInDomains } from "@/domains";
registerBuiltInDomains();
import { createSampleHousehold } from "@/data/sample-household";
import { evaluateSystem } from "@/model/evaluate";
import { computeSignature } from "@/signatures";
import {
  BandThresholdsSchema,
  BinaryStateSchema,
  ConstraintCheckSchema,
  ConstraintSchema,
  ContributionSchema,
  HypothesisSchema,
  LagSchema,
  LoopSnapshotItemSchema,
  MODEL_SCHEMA_VERSION,
  ObservationSchema,
  RelationshipSchema,
  RelationshipSnapshotItemSchema,
  SIGNATURE_SCHEMA_VERSION,
  StructuralSignatureSchema,
  SystemModelSchema,
} from "@/types";

const minimalObservation = { id: "o1", statement: "Seen", sourceType: "observed", confidence: 0.5 };
const minimalHypothesis = { id: "h1", statement: "Maybe", confidence: 0.5 };
const minimalConstraint = { id: "c1", name: "Rule", type: "hard", sourceType: "self_reported", confidence: 0.5 };
const minimalRelationship = {
  id: "r1",
  sourceVariableId: "a",
  targetVariableId: "b",
  kind: "causal_hypothesis" as const,
  participatesInDynamics: true,
  direction: "positive",
  strength: 0.5,
  lag: { value: 1, unit: "weeks" },
  confidence: 0.5,
  sourceType: "self_reported",
};

describe("ObservationSchema", () => {
  it("applies defaults, including a prefaulted links object", () => {
    const o = ObservationSchema.parse(minimalObservation);
    expect(o).toEqual({
      ...minimalObservation,
      dateOrPeriod: "",
      subjectId: "",
      evidenceSource: "",
      notes: "",
      links: { variableIds: [], relationshipIds: [], constraintIds: [], hypothesisIds: [] },
    });
    // A partial links object is filled in.
    expect(ObservationSchema.parse({ ...minimalObservation, links: { variableIds: ["x"] } }).links).toEqual({
      variableIds: ["x"],
      relationshipIds: [],
      constraintIds: [],
      hypothesisIds: [],
    });
  });
  it("rejects an empty statement, invalid sourceType and out-of-range confidence", () => {
    expect(ObservationSchema.safeParse({ ...minimalObservation, statement: "" }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...minimalObservation, sourceType: "guessed" }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...minimalObservation, confidence: 1.01 }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...minimalObservation, confidence: -0.01 }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...minimalObservation, confidence: 0 }).success).toBe(true);
    expect(ObservationSchema.safeParse({ ...minimalObservation, confidence: 1 }).success).toBe(true);
  });
});

describe("HypothesisSchema", () => {
  it("defaults status to proposed and kind to general with empty lists", () => {
    const h = HypothesisSchema.parse(minimalHypothesis);
    expect(h).toMatchObject({ subjectId: null, disconfirmingConditions: [], predictions: [], reviewLog: [], killCriteria: [] });
    expect(h).toMatchObject({
      ...minimalHypothesis,
      kind: "general",
      relationshipIds: [],
      supportingObservationIds: [],
      contradictingObservationIds: [],
      status: "proposed",
      notes: "",
    });
    expect(h.loopId).toBeUndefined();
  });
  it("accepts every status and kind, rejects unknown ones", () => {
    for (const status of ["proposed", "accepted", "rejected", "uncertain"]) {
      expect(HypothesisSchema.safeParse({ ...minimalHypothesis, status }).success).toBe(true);
    }
    for (const kind of ["loop", "relationship", "general"]) {
      expect(HypothesisSchema.safeParse({ ...minimalHypothesis, kind }).success).toBe(true);
    }
    expect(HypothesisSchema.safeParse({ ...minimalHypothesis, status: "proven" }).success).toBe(false);
    expect(HypothesisSchema.safeParse({ ...minimalHypothesis, kind: "theory" }).success).toBe(false);
    expect(HypothesisSchema.safeParse({ ...minimalHypothesis, confidence: 2 }).success).toBe(false);
  });
});

describe("ConstraintSchema", () => {
  it("defaults softPenalty 0.5, userConfirmed false, evidence [] and no check", () => {
    const c = ConstraintSchema.parse(minimalConstraint);
    expect(c).toEqual({ ...minimalConstraint, description: "", subjectId: null, softPenalty: 0.5, evidence: [], userConfirmed: false, notes: "" });
    expect(c.check).toBeUndefined();
  });
  it("validates type, comparator and limit shape", () => {
    expect(ConstraintSchema.safeParse({ ...minimalConstraint, type: "soft" }).success).toBe(true);
    expect(ConstraintSchema.safeParse({ ...minimalConstraint, type: "medium" }).success).toBe(false);
    expect(ConstraintSchema.safeParse({ ...minimalConstraint, softPenalty: 1.5 }).success).toBe(false);
    const check = { dimension: "hoursPerWeek", comparator: "lte", limit: 8 };
    expect(ConstraintSchema.parse({ ...minimalConstraint, check }).check).toEqual(check);
    expect(ConstraintCheckSchema.safeParse({ ...check, comparator: "lt" }).success).toBe(false);
    expect(ConstraintCheckSchema.safeParse({ ...check, dimension: "" }).success).toBe(false);
    expect(ConstraintCheckSchema.safeParse({ ...check, limit: "8" }).success).toBe(false);
    expect(ConstraintCheckSchema.safeParse({ ...check, comparator: "eq", limit: true }).success).toBe(true);
  });
});

describe("RelationshipSchema", () => {
  it("defaults enabled true, evidence [], explanation and notes ''", () => {
    const r = RelationshipSchema.parse(minimalRelationship);
    expect(r).toEqual({ ...minimalRelationship, evidence: [], explanation: "", notes: "", enabled: true });
    // An association can never take part in dynamics, whatever the flag says.
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, kind: "association", participatesInDynamics: true }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, kind: "unclassified", participatesInDynamics: true }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, kind: "unclassified", participatesInDynamics: false }).success).toBe(true);
    expect(RelationshipSchema.parse({ ...minimalRelationship, enabled: false }).enabled).toBe(false);
  });
  it("rejects invalid direction, strength/confidence bounds and lag units", () => {
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, direction: "sideways" }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, strength: 1.2 }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, strength: -0.1 }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, confidence: 1.0001 }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, lag: { value: 1, unit: "fortnights" } }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, lag: 3 }).success).toBe(false);
    expect(RelationshipSchema.safeParse({ ...minimalRelationship, sourceVariableId: "" }).success).toBe(false);
  });
});

describe("LagSchema", () => {
  it("accepts zero and positive values in the four units, rejects negatives and unknown units", () => {
    for (const unit of ["days", "weeks", "months", "years"]) {
      expect(LagSchema.parse({ value: 0, unit })).toEqual({ value: 0, unit });
      expect(LagSchema.parse({ value: 2.5, unit })).toEqual({ value: 2.5, unit });
    }
    expect(LagSchema.safeParse({ value: -1, unit: "days" }).success).toBe(false);
    expect(LagSchema.safeParse({ value: -0.001, unit: "years" }).success).toBe(false);
    expect(LagSchema.safeParse({ value: 1, unit: "hours" }).success).toBe(false);
    expect(LagSchema.safeParse({ value: "1", unit: "days" }).success).toBe(false);
  });
});

describe("SystemModelSchema", () => {
  it("pins the schema version and rejects v1 objects", () => {
    expect(MODEL_SCHEMA_VERSION).toBe(6);
    const sample = createSampleHousehold();
    expect(SystemModelSchema.safeParse(sample).success).toBe(true);
    expect(SystemModelSchema.safeParse({ ...sample, schemaVersion: 1 }).success).toBe(false);
    expect(SystemModelSchema.safeParse({ ...sample, schemaVersion: 2 }).success).toBe(false);
    expect(SystemModelSchema.safeParse({ ...sample, schemaVersion: 3 }).success).toBe(false);
    expect(SystemModelSchema.safeParse({ ...sample, schemaVersion: "4" }).success).toBe(false);
  });
  it("defaults signatures/events to [] and REQUIRES a domain definition reference", () => {
    const { signatures: _s, events: _e, observations: _o, hypotheses: _h, ...rest } = createSampleHousehold();
    void _s;
    void _e;
    void _o;
    void _h;
    const parsed = SystemModelSchema.parse(rest);
    expect(parsed.signatures).toEqual([]);
    expect(parsed.events).toEqual([]);
    expect(parsed.domainDefinitionId).toBe("household");
    const { domainDefinitionId: _d, ...noDomain } = rest;
    void _d;
    expect(SystemModelSchema.safeParse(noDomain).success).toBe(false);
    expect(parsed.observations).toEqual([]);
    expect(parsed.hypotheses).toEqual([]);
    expect(parsed.loopAnnotations).toEqual(createSampleHousehold().loopAnnotations);
  });
});

describe("StructuralSignatureSchema pieces", () => {
  it("BandThresholdsSchema requires four strictly ascending numbers", () => {
    expect(BandThresholdsSchema.parse([0.2, 0.4, 0.6, 0.8])).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(BandThresholdsSchema.safeParse([0.4, 0.2, 0.6, 0.8]).success).toBe(false);
    expect(BandThresholdsSchema.safeParse([0.2, 0.2, 0.6, 0.8]).success).toBe(false);
    expect(BandThresholdsSchema.safeParse([0.2, 0.4, 0.8, 0.6]).success).toBe(false);
    expect(BandThresholdsSchema.safeParse([0.2, 0.4, 0.6]).success).toBe(false);
    expect(BandThresholdsSchema.safeParse([0.2, 0.4, 0.6, 0.8, 1]).success).toBe(false);
    const r = BandThresholdsSchema.safeParse([1, 2, 3, 3]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("band thresholds must ascend");
  });
  it("snapshot items reject invalid enums and default evidence lists", () => {
    expect(BinaryStateSchema.safeParse("strong").success).toBe(true);
    expect(BinaryStateSchema.safeParse("medium").success).toBe(false);
    const loop = {
      id: "a>b",
      name: null,
      polarity: "reinforcing",
      variableIds: ["a", "b"],
      meanStrength: 0.5,
      pressure: null,
      cycleTimeMonths: 1,
      status: "proposed",
      minConfidence: 0.4,
    };
    expect(LoopSnapshotItemSchema.parse(loop)).toEqual(loop);
    expect(LoopSnapshotItemSchema.safeParse({ ...loop, polarity: "neutral" }).success).toBe(false);
    expect(LoopSnapshotItemSchema.safeParse({ ...loop, status: "proven" }).success).toBe(false);
    const contribution = ContributionSchema.parse({
      variableId: "v",
      variableKey: "v",
      name: "V",
      unit: "$",
      rawValue: null,
      normalized: null,
      weight: 1,
      required: false,
      sourceType: null,
      confidence: null,
      transform: { kind: "ratio", strongAt: 1.5 },
      invert: false,
    });
    expect(contribution.evidenceTexts).toEqual([]);
    expect(contribution.observationIds).toEqual([]);
    expect(ContributionSchema.safeParse({ ...contribution, transform: { kind: "ratio", strongAt: 0 } }).success).toBe(false);
    expect(ContributionSchema.safeParse({ ...contribution, transform: { kind: "cubic" } }).success).toBe(false);
  });
  it("a computed signature validates; the schema version literal and enums are enforced", () => {
    const sig = computeSignature(evaluateSystem(createSampleHousehold()), { id: "sig_1", now: "2026-09-14T00:00:00.000Z", mode: "current" });
    expect(SIGNATURE_SCHEMA_VERSION).toBe(1);
    expect(sig.schemaVersion).toBe(1);
    expect(StructuralSignatureSchema.safeParse(sig).success).toBe(true);
    expect(StructuralSignatureSchema.safeParse({ ...sig, schemaVersion: 2 }).success).toBe(false);
    expect(StructuralSignatureSchema.safeParse({ ...sig, mode: "future" }).success).toBe(false);
    expect(StructuralSignatureSchema.safeParse({ ...sig, completeness: 1.5 }).success).toBe(false);
    expect(StructuralSignatureSchema.safeParse({ ...sig, systemId: "" }).success).toBe(false);
    const item = sig.relationshipSnapshot[0];
    expect(RelationshipSnapshotItemSchema.safeParse(item).success).toBe(true);
    expect(RelationshipSnapshotItemSchema.safeParse({ ...item, direction: "up" }).success).toBe(false);
    expect(RelationshipSnapshotItemSchema.safeParse({ ...item, lag: { value: -1, unit: "days" } }).success).toBe(false);
  });
});
