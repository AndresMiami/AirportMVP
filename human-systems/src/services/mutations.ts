/**
 * Pure mutations on a SystemModel. Every editor in the UI goes through
 * one of these: each returns a NEW model validated by the Zod schema, or
 * throws MutationError with a message meant for the person. Nothing here
 * touches storage or React.
 */
import { DERIVED_BY_ID } from "@/model/derived";
import {
  ConstraintSchema,
  HypothesisSchema,
  IncomeSourceSchema,
  MemberSchema,
  ObservationSchema,
  RelationshipSchema,
  SystemModelSchema,
  VariableSchema,
  type AttractorDescription,
  type Constraint,
  type Hypothesis,
  type HypothesisStatus,
  type IncomeSource,
  type LoopAnnotation,
  type Member,
  type Observation,
  type Relationship,
  type StructuralSignature,
  type SystemModel,
  type SystemProfile,
  type Variable,
} from "@/types";

export class MutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationError";
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic id: prefix + (highest existing numeric suffix + 1). */
export function nextId(model: SystemModel, prefix: string): string {
  const taken = new Set<string>([
    ...model.variables.map((v) => v.id),
    ...model.incomeSources.map((s) => s.id),
    ...model.relationships.map((r) => r.id),
    ...model.constraints.map((c) => c.id),
    ...model.actions.map((a) => a.id),
    ...model.observations.map((o) => o.id),
    ...model.hypotheses.map((h) => h.id),
    ...model.profile.members.map((m) => m.id),
  ]);
  let max = 0;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const id of taken) {
    const m = id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let candidate = `${prefix}_${max + 1}`;
  while (taken.has(candidate)) candidate = `${candidate}x`;
  return candidate;
}

export function slugId(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function commit(model: SystemModel): SystemModel {
  const parsed = SystemModelSchema.safeParse(model);
  if (!parsed.success) throw new MutationError(`Invalid model: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  return parsed.data;
}

function requireVariable(model: SystemModel, id: string): Variable {
  const v = model.variables.find((x) => x.id === id);
  if (!v) throw new MutationError(`Unknown variable "${id}"`);
  return v;
}

function requireRelationship(model: SystemModel, id: string): Relationship {
  const r = model.relationships.find((x) => x.id === id);
  if (!r) throw new MutationError(`Unknown relationship "${id}"`);
  return r;
}

function requireObservation(model: SystemModel, id: string): Observation {
  const o = model.observations.find((x) => x.id === id);
  if (!o) throw new MutationError(`Unknown observation "${id}"`);
  return o;
}

function requireHypothesis(model: SystemModel, id: string): Hypothesis {
  const h = model.hypotheses.find((x) => x.id === id);
  if (!h) throw new MutationError(`Unknown hypothesis "${id}"`);
  return h;
}

function requireConstraint(model: SystemModel, id: string): Constraint {
  const c = model.constraints.find((x) => x.id === id);
  if (!c) throw new MutationError(`Unknown constraint "${id}"`);
  return c;
}

/* ------------------------------------------------------------------ */
/* Profile and members                                                 */
/* ------------------------------------------------------------------ */

export function updateProfile(model: SystemModel, patch: Partial<Omit<SystemProfile, "members">>): SystemModel {
  return commit({ ...model, profile: { ...model.profile, ...patch } });
}

export function addMember(model: SystemModel, input: { id?: string; label: string; role?: string }): SystemModel {
  const id = input.id ?? nextId(model, "member");
  if (model.profile.members.some((m) => m.id === id)) throw new MutationError(`Member "${id}" already exists`);
  const member = MemberSchema.parse({ id, label: input.label, role: input.role ?? "" });
  return commit({ ...model, profile: { ...model.profile, members: [...model.profile.members, member] } });
}

export function updateMember(model: SystemModel, id: string, patch: Partial<Omit<Member, "id">>): SystemModel {
  if (!model.profile.members.some((m) => m.id === id)) throw new MutationError(`Unknown member "${id}"`);
  return commit({
    ...model,
    profile: {
      ...model.profile,
      members: model.profile.members.map((m) => (m.id === id ? MemberSchema.parse({ ...m, ...patch }) : m)),
    },
  });
}

/** Removing a member clears it as the subject of observations (they stay). */
export function removeMember(model: SystemModel, id: string): SystemModel {
  if (!model.profile.members.some((m) => m.id === id)) throw new MutationError(`Unknown member "${id}"`);
  return commit({
    ...model,
    profile: { ...model.profile, members: model.profile.members.filter((m) => m.id !== id) },
    observations: model.observations.map((o) => (o.subjectId === id ? { ...o, subjectId: "" } : o)),
  });
}

export function setCurrentAttractor(model: SystemModel, patch: Partial<AttractorDescription>): SystemModel {
  return commit({ ...model, currentAttractor: { ...model.currentAttractor, ...patch } });
}

export function setDesiredAttractor(model: SystemModel, patch: Partial<AttractorDescription>): SystemModel {
  return commit({ ...model, desiredAttractor: { ...model.desiredAttractor, ...patch } });
}

/* ------------------------------------------------------------------ */
/* Income sources                                                      */
/* ------------------------------------------------------------------ */

export type IncomeSourceInput = Omit<IncomeSource, "id" | "evidence" | "notes" | "earner"> &
  Partial<Pick<IncomeSource, "id" | "evidence" | "notes" | "earner">>;

export function addIncomeSource(model: SystemModel, input: IncomeSourceInput): SystemModel {
  const id = input.id ?? nextId(model, "inc");
  if (model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Income source "${id}" already exists`);
  const source = IncomeSourceSchema.parse({ ...input, id });
  return commit({ ...model, incomeSources: [...model.incomeSources, source] });
}

export function updateIncomeSource(model: SystemModel, id: string, patch: Partial<Omit<IncomeSource, "id">>): SystemModel {
  if (!model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Unknown income source "${id}"`);
  return commit({
    ...model,
    incomeSources: model.incomeSources.map((s) => (s.id === id ? IncomeSourceSchema.parse({ ...s, ...patch }) : s)),
  });
}

export function removeIncomeSource(model: SystemModel, id: string): SystemModel {
  if (!model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Unknown income source "${id}"`);
  return commit({ ...model, incomeSources: model.incomeSources.filter((s) => s.id !== id) });
}

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

export type VariableInput = Pick<Variable, "name" | "category" | "changeSpeed" | "unit" | "sourceType" | "confidence"> &
  Partial<
    Pick<
      Variable,
      | "id"
      | "description"
      | "currentValue"
      | "desiredValue"
      | "targetMode"
      | "evidence"
      | "controllability"
      | "durability"
      | "estimatedCostToChange"
      | "impact"
      | "effectUncertainty"
      | "referenceRange"
      | "notes"
    >
  >;

/** Adds an INPUT variable. Derived variables come only from model/derived. */
export function addVariable(model: SystemModel, input: VariableInput): SystemModel {
  const id = input.id ?? uniqueSlug(model, slugId(input.name, "variable"));
  if (model.variables.some((v) => v.id === id)) throw new MutationError(`Variable "${id}" already exists`);
  if (DERIVED_BY_ID[id]) throw new MutationError(`"${id}" is reserved for a calculated variable`);
  const variable = VariableSchema.parse({
    description: "",
    currentValue: null,
    desiredValue: null,
    targetMode: "exact",
    evidence: [],
    controllability: 0.5,
    durability: 0.5,
    estimatedCostToChange: 0.5,
    notes: "",
    ...input,
    id,
    kind: "input",
    formulaId: undefined,
  });
  return commit({ ...model, variables: [...model.variables, variable] });
}

function uniqueSlug(model: SystemModel, base: string): string {
  const taken = new Set(model.variables.map((v) => v.id));
  if (!taken.has(base) && !DERIVED_BY_ID[base]) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`) || DERIVED_BY_ID[`${base}_${n}`]) n += 1;
  return `${base}_${n}`;
}

/** Derived variables keep their computed fields protected: only desired
 *  value, target mode, notes and judgments may change. */
export function updateVariable(model: SystemModel, id: string, patch: Partial<Omit<Variable, "id">>): SystemModel {
  const current = requireVariable(model, id);
  const merged: Variable = { ...current, ...patch, id };
  if (current.kind === "derived") {
    merged.kind = "derived";
    merged.currentValue = current.currentValue;
    merged.sourceType = "calculated";
    merged.confidence = current.confidence;
    merged.formulaId = current.formulaId;
    merged.unit = current.unit;
  } else {
    merged.kind = "input";
  }
  return commit({ ...model, variables: model.variables.map((v) => (v.id === id ? VariableSchema.parse(merged) : v)) });
}

/** Removes an input variable and everything that pointed at it:
 *  relationships (and their hypothesis/observation references), observation
 *  links, action targets. Derived variables cannot be removed. */
export function removeVariable(model: SystemModel, id: string): SystemModel {
  const v = requireVariable(model, id);
  if (v.kind === "derived") throw new MutationError(`${v.name} is calculated and cannot be removed`);
  const goneRelationships = new Set(
    model.relationships.filter((r) => r.sourceVariableId === id || r.targetVariableId === id).map((r) => r.id),
  );
  return commit({
    ...model,
    variables: model.variables.filter((x) => x.id !== id),
    relationships: model.relationships.filter((r) => !goneRelationships.has(r.id)),
    actions: model.actions.map((a) => ({ ...a, targetVariables: a.targetVariables.filter((t) => t !== id) })),
    observations: model.observations.map((o) => ({
      ...o,
      links: {
        ...o.links,
        variableIds: o.links.variableIds.filter((x) => x !== id),
        relationshipIds: o.links.relationshipIds.filter((x) => !goneRelationships.has(x)),
      },
    })),
    hypotheses: model.hypotheses.map((h) => ({
      ...h,
      relationshipIds: h.relationshipIds.filter((x) => !goneRelationships.has(x)),
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Relationships                                                       */
/* ------------------------------------------------------------------ */

export type RelationshipInput = Pick<
  Relationship,
  "sourceVariableId" | "targetVariableId" | "direction" | "strength" | "lag" | "confidence" | "sourceType"
> &
  Partial<Pick<Relationship, "id" | "evidence" | "explanation" | "notes" | "enabled">>;

function validateEndpoints(model: SystemModel, sourceId: string, targetId: string, selfId?: string): void {
  requireVariable(model, sourceId);
  requireVariable(model, targetId);
  if (sourceId === targetId) throw new MutationError("A relationship needs two different variables");
  const duplicate = model.relationships.find(
    (r) => r.id !== selfId && r.sourceVariableId === sourceId && r.targetVariableId === targetId,
  );
  if (duplicate) {
    throw new MutationError(
      `A relationship from "${sourceId}" to "${targetId}" already exists (${duplicate.id}); edit it instead of adding another`,
    );
  }
}

export function addRelationship(model: SystemModel, input: RelationshipInput): SystemModel {
  validateEndpoints(model, input.sourceVariableId, input.targetVariableId);
  const id = input.id ?? nextId(model, "rel");
  if (model.relationships.some((r) => r.id === id)) throw new MutationError(`Relationship "${id}" already exists`);
  const relationship = RelationshipSchema.parse({
    evidence: [],
    explanation: "",
    notes: "",
    enabled: true,
    ...input,
    id,
  });
  return commit({ ...model, relationships: [...model.relationships, relationship] });
}

export function updateRelationship(model: SystemModel, id: string, patch: Partial<Omit<Relationship, "id">>): SystemModel {
  const current = requireRelationship(model, id);
  const merged = RelationshipSchema.parse({ ...current, ...patch, id });
  validateEndpoints(model, merged.sourceVariableId, merged.targetVariableId, id);
  return commit({ ...model, relationships: model.relationships.map((r) => (r.id === id ? merged : r)) });
}

export function setRelationshipEnabled(model: SystemModel, id: string, enabled: boolean): SystemModel {
  return updateRelationship(model, id, { enabled });
}

/** Removes the edge and prunes every reference to it. */
export function removeRelationship(model: SystemModel, id: string): SystemModel {
  requireRelationship(model, id);
  return commit({
    ...model,
    relationships: model.relationships.filter((r) => r.id !== id),
    observations: model.observations.map((o) => ({
      ...o,
      links: { ...o.links, relationshipIds: o.links.relationshipIds.filter((x) => x !== id) },
    })),
    hypotheses: model.hypotheses.map((h) => ({ ...h, relationshipIds: h.relationshipIds.filter((x) => x !== id) })),
  });
}

export function setLoopAnnotation(model: SystemModel, loopId: string, annotation: LoopAnnotation | null): SystemModel {
  const loopAnnotations = { ...model.loopAnnotations };
  if (annotation) loopAnnotations[loopId] = annotation;
  else delete loopAnnotations[loopId];
  return commit({ ...model, loopAnnotations });
}

/* ------------------------------------------------------------------ */
/* Constraints                                                         */
/* ------------------------------------------------------------------ */

export type ConstraintInput = Pick<Constraint, "name" | "type" | "sourceType" | "confidence"> &
  Partial<Pick<Constraint, "id" | "description" | "check" | "softPenalty" | "evidence" | "userConfirmed" | "notes">>;

export function addConstraint(model: SystemModel, input: ConstraintInput): SystemModel {
  const id = input.id ?? nextId(model, "con");
  if (model.constraints.some((c) => c.id === id)) throw new MutationError(`Constraint "${id}" already exists`);
  const constraint = ConstraintSchema.parse({ description: "", evidence: [], userConfirmed: false, notes: "", ...input, id });
  return commit({ ...model, constraints: [...model.constraints, constraint] });
}

export function updateConstraint(model: SystemModel, id: string, patch: Partial<Omit<Constraint, "id">>): SystemModel {
  const current = requireConstraint(model, id);
  const merged = ConstraintSchema.parse({ ...current, ...patch, id });
  return commit({ ...model, constraints: model.constraints.map((c) => (c.id === id ? merged : c)) });
}

export function removeConstraint(model: SystemModel, id: string): SystemModel {
  requireConstraint(model, id);
  return commit({
    ...model,
    constraints: model.constraints.filter((c) => c.id !== id),
    observations: model.observations.map((o) => ({
      ...o,
      links: { ...o.links, constraintIds: o.links.constraintIds.filter((x) => x !== id) },
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

export type ObservationInput = Pick<Observation, "statement" | "sourceType" | "confidence"> &
  Partial<Pick<Observation, "id" | "dateOrPeriod" | "subjectId" | "evidenceSource" | "notes" | "links">>;

export type LinkTarget =
  | { kind: "variable"; id: string }
  | { kind: "relationship"; id: string }
  | { kind: "constraint"; id: string }
  | { kind: "hypothesis"; id: string };

function validateSubject(model: SystemModel, subjectId: string | undefined): void {
  if (!subjectId) return;
  if (subjectId === model.id) return;
  if (!model.profile.members.some((m) => m.id === subjectId)) {
    throw new MutationError(`Unknown subject "${subjectId}" (use a member id or the system id)`);
  }
}

function validateLinks(model: SystemModel, links: Observation["links"]): void {
  for (const id of links.variableIds) requireVariable(model, id);
  for (const id of links.relationshipIds) requireRelationship(model, id);
  for (const id of links.constraintIds) requireConstraint(model, id);
  for (const id of links.hypothesisIds) requireHypothesis(model, id);
}

export function addObservation(model: SystemModel, input: ObservationInput): SystemModel {
  const id = input.id ?? nextId(model, "obs");
  if (model.observations.some((o) => o.id === id)) throw new MutationError(`Observation "${id}" already exists`);
  validateSubject(model, input.subjectId);
  const observation = ObservationSchema.parse({ dateOrPeriod: "", subjectId: "", evidenceSource: "", notes: "", ...input, id });
  validateLinks(model, observation.links);
  return commit({ ...model, observations: [...model.observations, observation] });
}

export function updateObservation(model: SystemModel, id: string, patch: Partial<Omit<Observation, "id">>): SystemModel {
  const current = requireObservation(model, id);
  const merged = ObservationSchema.parse({ ...current, ...patch, id });
  validateSubject(model, merged.subjectId);
  validateLinks(model, merged.links);
  return commit({ ...model, observations: model.observations.map((o) => (o.id === id ? merged : o)) });
}

/** Removes the observation and drops it from every hypothesis. */
export function removeObservation(model: SystemModel, id: string): SystemModel {
  requireObservation(model, id);
  return commit({
    ...model,
    observations: model.observations.filter((o) => o.id !== id),
    hypotheses: model.hypotheses.map((h) => ({
      ...h,
      supportingObservationIds: h.supportingObservationIds.filter((x) => x !== id),
      contradictingObservationIds: h.contradictingObservationIds.filter((x) => x !== id),
    })),
  });
}

const LINK_KEY: Record<LinkTarget["kind"], keyof Observation["links"]> = {
  variable: "variableIds",
  relationship: "relationshipIds",
  constraint: "constraintIds",
  hypothesis: "hypothesisIds",
};

export function linkObservation(model: SystemModel, observationId: string, target: LinkTarget): SystemModel {
  const o = requireObservation(model, observationId);
  const key = LINK_KEY[target.kind];
  if (o.links[key].includes(target.id)) return model;
  const links = { ...o.links, [key]: [...o.links[key], target.id] };
  return updateObservation(model, observationId, { links });
}

export function unlinkObservation(model: SystemModel, observationId: string, target: LinkTarget): SystemModel {
  const o = requireObservation(model, observationId);
  const key = LINK_KEY[target.kind];
  const links = { ...o.links, [key]: o.links[key].filter((x) => x !== target.id) };
  return updateObservation(model, observationId, { links });
}

/* ------------------------------------------------------------------ */
/* Hypotheses                                                          */
/* ------------------------------------------------------------------ */

export type HypothesisInput = Pick<Hypothesis, "statement" | "confidence"> &
  Partial<
    Pick<
      Hypothesis,
      "id" | "kind" | "loopId" | "relationshipIds" | "supportingObservationIds" | "contradictingObservationIds" | "status" | "notes"
    >
  >;

function validateHypothesisRefs(model: SystemModel, h: Hypothesis): void {
  for (const id of h.relationshipIds) requireRelationship(model, id);
  for (const id of h.supportingObservationIds) requireObservation(model, id);
  for (const id of h.contradictingObservationIds) requireObservation(model, id);
  const both = h.supportingObservationIds.filter((id) => h.contradictingObservationIds.includes(id));
  if (both.length > 0) throw new MutationError(`Observation "${both[0]}" cannot both support and contradict the same hypothesis`);
  if (h.kind === "loop" && !h.loopId) throw new MutationError("A loop hypothesis needs a loopId");
  if (h.kind === "loop" && h.loopId && model.hypotheses.some((x) => x.id !== h.id && x.kind === "loop" && x.loopId === h.loopId)) {
    throw new MutationError(`Loop ${h.loopId} already has a hypothesis; edit that one`);
  }
}

export function addHypothesis(model: SystemModel, input: HypothesisInput): SystemModel {
  const id = input.id ?? nextId(model, "hyp");
  if (model.hypotheses.some((h) => h.id === id)) throw new MutationError(`Hypothesis "${id}" already exists`);
  const hypothesis = HypothesisSchema.parse({
    kind: "general",
    relationshipIds: [],
    supportingObservationIds: [],
    contradictingObservationIds: [],
    status: "proposed",
    notes: "",
    ...input,
    id,
  });
  validateHypothesisRefs(model, hypothesis);
  return commit({ ...model, hypotheses: [...model.hypotheses, hypothesis] });
}

export function updateHypothesis(model: SystemModel, id: string, patch: Partial<Omit<Hypothesis, "id">>): SystemModel {
  const current = requireHypothesis(model, id);
  const merged = HypothesisSchema.parse({ ...current, ...patch, id });
  validateHypothesisRefs(model, merged);
  return commit({ ...model, hypotheses: model.hypotheses.map((h) => (h.id === id ? merged : h)) });
}

export function setHypothesisStatus(model: SystemModel, id: string, status: HypothesisStatus): SystemModel {
  return updateHypothesis(model, id, { status });
}

/** Removes the hypothesis and drops it from observation links. */
export function removeHypothesis(model: SystemModel, id: string): SystemModel {
  requireHypothesis(model, id);
  return commit({
    ...model,
    hypotheses: model.hypotheses.filter((h) => h.id !== id),
    observations: model.observations.map((o) => ({
      ...o,
      links: { ...o.links, hypothesisIds: o.links.hypothesisIds.filter((x) => x !== id) },
    })),
  });
}

/** Attach an observation as supporting or contradicting; moves it if it
 *  was already on the other side. */
export function attachObservationToHypothesis(
  model: SystemModel,
  hypothesisId: string,
  observationId: string,
  role: "supporting" | "contradicting",
): SystemModel {
  const h = requireHypothesis(model, hypothesisId);
  requireObservation(model, observationId);
  const supporting = h.supportingObservationIds.filter((x) => x !== observationId);
  const contradicting = h.contradictingObservationIds.filter((x) => x !== observationId);
  if (role === "supporting") supporting.push(observationId);
  else contradicting.push(observationId);
  return updateHypothesis(model, hypothesisId, {
    supportingObservationIds: supporting,
    contradictingObservationIds: contradicting,
  });
}

export function detachObservationFromHypothesis(model: SystemModel, hypothesisId: string, observationId: string): SystemModel {
  const h = requireHypothesis(model, hypothesisId);
  return updateHypothesis(model, hypothesisId, {
    supportingObservationIds: h.supportingObservationIds.filter((x) => x !== observationId),
    contradictingObservationIds: h.contradictingObservationIds.filter((x) => x !== observationId),
  });
}

/** Create the hypothesis record for a detected loop if none exists yet.
 *  Status starts as "proposed": a loop is never more than a hypothesis. */
export function ensureLoopHypothesis(
  model: SystemModel,
  input: { loopId: string; statement: string; relationshipIds?: string[]; confidence?: number },
): SystemModel {
  if (model.hypotheses.some((h) => h.kind === "loop" && h.loopId === input.loopId)) return model;
  return addHypothesis(model, {
    kind: "loop",
    loopId: input.loopId,
    statement: input.statement,
    relationshipIds: input.relationshipIds ?? [],
    confidence: input.confidence ?? 0.5,
    status: "proposed",
  });
}

/* ------------------------------------------------------------------ */
/* Structural signature snapshots                                      */
/* ------------------------------------------------------------------ */

/** Store a COMPUTED signature. The snapshot itself is never edited: only
 *  its label and notes may change afterwards (updateSignatureMeta). */
export function addSignatureSnapshot(model: SystemModel, signature: StructuralSignature): SystemModel {
  if (signature.systemId !== model.id) throw new MutationError("Snapshot belongs to a different system");
  if (model.signatures.some((s) => s.id === signature.id)) throw new MutationError(`Snapshot "${signature.id}" already exists`);
  return commit({ ...model, signatures: [...model.signatures, signature] });
}

export function updateSignatureMeta(model: SystemModel, id: string, patch: { label?: string; notes?: string }): SystemModel {
  if (!model.signatures.some((s) => s.id === id)) throw new MutationError(`Unknown snapshot "${id}"`);
  return commit({
    ...model,
    signatures: model.signatures.map((s) => (s.id === id ? { ...s, label: patch.label ?? s.label, notes: patch.notes ?? s.notes } : s)),
  });
}

export function removeSignatureSnapshot(model: SystemModel, id: string): SystemModel {
  if (!model.signatures.some((s) => s.id === id)) throw new MutationError(`Unknown snapshot "${id}"`);
  return commit({ ...model, signatures: model.signatures.filter((s) => s.id !== id) });
}

export function nextSignatureId(model: SystemModel): string {
  const taken = new Set(model.signatures.map((s) => s.id));
  let n = model.signatures.length + 1;
  while (taken.has(`sig_${n}`)) n += 1;
  return `sig_${n}`;
}
