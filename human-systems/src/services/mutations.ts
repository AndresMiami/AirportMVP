/**
 * Pure mutations on a SystemModel. Every editor in the UI goes through
 * one of these: each returns a NEW model validated by the Zod schema, or
 * throws MutationError with a message meant for the person. Nothing here
 * touches storage or React.
 */
import { z } from "zod";
import { DYNAMICS_ELIGIBLE_KINDS, EventSchema, type Event, type ExtensionEnvelope, type KillCriterion, type RelationshipKind, type SubjectId } from "@/types";
import { domainRegistry, resolveVariable, variableIdFor } from "@/model/domain";
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
    ...model.events.map((e) => e.id),
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
  if (!parsed.success) throw new MutationError(`Invalid model: ${describe(parsed.error)}`);
  return parsed.data;
}

/** Validate one entity; a refusal is a MutationError naming the field. */
function parseOr<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MutationError(`Invalid ${what}: ${describe(parsed.error)}`);
  return parsed.data;
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validation failed";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
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
  const member = parseOr(MemberSchema, { id, label: input.label, role: input.role ?? "" }, "member");
  return commit({ ...model, profile: { ...model.profile, members: [...model.profile.members, member] } });
}

export function updateMember(model: SystemModel, id: string, patch: Partial<Omit<Member, "id">>): SystemModel {
  if (!model.profile.members.some((m) => m.id === id)) throw new MutationError(`Unknown member "${id}"`);
  return commit({
    ...model,
    profile: {
      ...model.profile,
      members: model.profile.members.map((m) => (m.id === id ? parseOr(MemberSchema, { ...m, ...patch }, "member") : m)),
    },
  });
}

/** Where a member is referenced as a subject, canonical or historical. */
export interface MemberReferences {
  variables: number;
  incomeSources: number;
  constraints: number;
  actions: number;
  hypotheses: number;
  events: number;
  observations: number;
  signatures: number;
  total: number;
}

export function memberReferences(model: SystemModel, id: string): MemberReferences {
  const refs = {
    variables: model.variables.filter((v) => v.subjectId === id).length,
    incomeSources: model.incomeSources.filter((s) => s.earnerId === id).length,
    constraints: model.constraints.filter((c) => c.subjectId === id).length,
    actions: model.actions.filter((a) => a.subjectId === id).length,
    hypotheses: model.hypotheses.filter((h) => h.subjectId === id).length,
    events: model.events.filter((e) => e.subjectId === id).length,
    observations: model.observations.filter((o) => o.subjectId === id).length,
    signatures: model.signatures.filter((s) => s.subjectId === id).length,
  };
  return { ...refs, total: Object.values(refs).reduce((a, b) => a + b, 0) };
}

/** Archive a member: the id stays, every observation keeps naming them.
 *  History is an asset; leaving the household is a status change. */
export function archiveMember(model: SystemModel, id: string): SystemModel {
  return updateMember(model, id, { status: "archived" });
}

export function restoreMember(model: SystemModel, id: string): SystemModel {
  return updateMember(model, id, { status: "active" });
}

/** Hard deletion is allowed only while nothing in the history names the
 *  member. Otherwise archive them; the historical attribution must survive. */
export function removeMember(model: SystemModel, id: string): SystemModel {
  if (!model.profile.members.some((m) => m.id === id)) throw new MutationError(`Unknown member "${id}"`);
  const refs = memberReferences(model, id);
  if (refs.total > 0) {
    const parts = (Object.entries(refs) as [string, number][])
      .filter(([k, n]) => k !== "total" && n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    throw new MutationError(`${parts} reference this member; archive them instead so the history keeps its subject`);
  }
  return commit({
    ...model,
    profile: { ...model.profile, members: model.profile.members.filter((m) => m.id !== id) },
  });
}

/** A subject must be the system id or a member id (active or archived); null = unassigned. */
function requireSubject(model: SystemModel, subjectId: SubjectId | null | undefined, what: string): void {
  if (subjectId === null || subjectId === undefined) return;
  if (subjectId === model.id) return;
  if (!model.profile.members.some((m) => m.id === subjectId)) throw new MutationError(`Unknown subject "${subjectId}" for ${what}`);
}

/** Assign (or clear) the subject of an input variable. */
export function assignVariableSubject(model: SystemModel, variableId: string, subjectId: SubjectId | null): SystemModel {
  const v = requireVariable(model, variableId);
  if (v.kind === "derived") throw new MutationError(`${v.name} is calculated; its subject is the system`);
  requireSubject(model, subjectId, "variable");
  const clash = model.variables.find((x) => x.id !== variableId && x.key === v.key && x.subjectId === subjectId && subjectId !== null);
  if (clash) throw new MutationError(`${clash.name} already holds key "${v.key}" for that subject`);
  return commit({ ...model, variables: model.variables.map((x) => (x.id === variableId ? { ...x, subjectId } : x)) });
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

export type IncomeSourceInput = Omit<IncomeSource, "id" | "evidence" | "notes" | "earner" | "earnerId"> &
  Partial<Pick<IncomeSource, "id" | "evidence" | "notes" | "earner" | "earnerId">>;

export function addIncomeSource(model: SystemModel, input: IncomeSourceInput): SystemModel {
  const id = input.id ?? nextId(model, "inc");
  if (model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Income source "${id}" already exists`);
  requireSubject(model, input.earnerId, "income source");
  const source = parseOr(IncomeSourceSchema, { ...input, id }, "income source");
  return commit({ ...model, incomeSources: [...model.incomeSources, source] });
}

export function updateIncomeSource(model: SystemModel, id: string, patch: Partial<Omit<IncomeSource, "id">>): SystemModel {
  if (!model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Unknown income source "${id}"`);
  requireSubject(model, patch.earnerId, "income source");
  return commit({
    ...model,
    incomeSources: model.incomeSources.map((s) => (s.id === id ? parseOr(IncomeSourceSchema, { ...s, ...patch }, "income source") : s)),
  });
}

export function removeIncomeSource(model: SystemModel, id: string): SystemModel {
  if (!model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Unknown income source "${id}"`);
  return commit({ ...model, incomeSources: model.incomeSources.filter((s) => s.id !== id) });
}

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

export type VariableInput = Pick<Variable, "name" | "category" | "changeSpeed" | "unit" | "sourceType" | "confidence"> & {
  /** Whose variable; null = unassigned. Required so nobody defaults it. */
  subjectId: SubjectId | null;
  /** Definition key; defaults to a slug of the name. */
  key?: string;
} & Partial<
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

/** Adds an INPUT variable. Derived variables come only from the domain. */
export function addVariable(model: SystemModel, input: VariableInput): SystemModel {
  requireSubject(model, input.subjectId, "variable");
  // key: explicit, else the explicit id (callers name standard inputs by id), else a slug of the name
  const key = input.key ?? input.id ?? slugId(input.name, "variable");
  const domain = domainRegistry.get(model.domainDefinitionId, model.domainDefinitionVersion);
  if (domain?.derived.some((d) => d.key === key)) throw new MutationError(`"${key}" is a calculated variable and cannot be entered`);
  const existing = resolveVariable(model.variables, model.id, { key, subjectId: input.subjectId });
  if (existing && input.subjectId !== null) throw new MutationError(`${existing.name} already holds key "${key}" for that subject`);
  const id = input.id ?? uniqueId(model, input.subjectId === null ? uniqueSlug(model, key) : variableIdFor(key, input.subjectId, model.id));
  if (model.variables.some((v) => v.id === id)) throw new MutationError(`Variable "${id}" already exists`);
  const variable = parseOr(VariableSchema, {
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
    key,
    kind: "input",
    formulaId: undefined,
  }, "variable");
  return commit({ ...model, variables: [...model.variables, variable] });
}

function uniqueSlug(model: SystemModel, base: string): string {
  const taken = new Set(model.variables.map((v) => v.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function uniqueId(model: SystemModel, base: string): string {
  return uniqueSlug(model, base);
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
    merged.key = current.key;
    merged.subjectId = current.subjectId;
  } else {
    merged.kind = "input";
    if (patch.subjectId !== undefined) requireSubject(model, patch.subjectId, "variable");
  }
  return commit({ ...model, variables: model.variables.map((v) => (v.id === id ? parseOr(VariableSchema, merged, "variable") : v)) });
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
  "sourceVariableId" | "targetVariableId" | "direction" | "strength" | "lag" | "confidence" | "sourceType" | "kind"
> &
  Partial<Pick<Relationship, "id" | "evidence" | "explanation" | "notes" | "enabled" | "participatesInDynamics" | "hypothesisId">>;

function validateDynamics(kind: RelationshipKind, participatesInDynamics: boolean): void {
  if (participatesInDynamics && !DYNAMICS_ELIGIBLE_KINDS.includes(kind)) {
    throw new MutationError(`A ${kind.replace("_", " ")} relationship cannot take part in loops or propagation; classify it as a causal hypothesis or definitional first`);
  }
}

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
  validateDynamics(input.kind, input.participatesInDynamics ?? false);
  const relationship = parseOr(RelationshipSchema, {
    evidence: [],
    explanation: "",
    notes: "",
    enabled: true,
    participatesInDynamics: false,
    ...input,
    id,
  }, "relationship");
  return commit({ ...model, relationships: [...model.relationships, relationship] });
}

export function updateRelationship(model: SystemModel, id: string, patch: Partial<Omit<Relationship, "id">>): SystemModel {
  const current = requireRelationship(model, id);
  const kind = patch.kind ?? current.kind;
  // Reclassifying to a non-eligible kind switches dynamics off; it never stays on silently.
  const participates = DYNAMICS_ELIGIBLE_KINDS.includes(kind) ? (patch.participatesInDynamics ?? current.participatesInDynamics) : false;
  if (patch.participatesInDynamics === true) validateDynamics(kind, true);
  const merged = parseOr(RelationshipSchema, { ...current, ...patch, kind, participatesInDynamics: participates, id }, "relationship");
  validateEndpoints(model, merged.sourceVariableId, merged.targetVariableId, id);
  return commit({ ...model, relationships: model.relationships.map((r) => (r.id === id ? merged : r)) });
}

export function setRelationshipEnabled(model: SystemModel, id: string, enabled: boolean): SystemModel {
  return updateRelationship(model, id, { enabled });
}

export function setRelationshipKind(model: SystemModel, id: string, kind: RelationshipKind): SystemModel {
  return updateRelationship(model, id, { kind });
}

/** Opt an eligible edge into (or out of) loops and propagation. */
export function setRelationshipDynamics(model: SystemModel, id: string, participatesInDynamics: boolean): SystemModel {
  const current = requireRelationship(model, id);
  validateDynamics(current.kind, participatesInDynamics);
  return updateRelationship(model, id, { participatesInDynamics });
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
  Partial<Pick<Constraint, "id" | "description" | "subjectId" | "check" | "softPenalty" | "evidence" | "userConfirmed" | "notes">>;

export function addConstraint(model: SystemModel, input: ConstraintInput): SystemModel {
  const id = input.id ?? nextId(model, "con");
  if (model.constraints.some((c) => c.id === id)) throw new MutationError(`Constraint "${id}" already exists`);
  requireSubject(model, input.subjectId, "constraint");
  const constraint = parseOr(ConstraintSchema, { description: "", evidence: [], userConfirmed: false, notes: "", ...input, id }, "constraint");
  return commit({ ...model, constraints: [...model.constraints, constraint] });
}

export function updateConstraint(model: SystemModel, id: string, patch: Partial<Omit<Constraint, "id">>): SystemModel {
  const current = requireConstraint(model, id);
  requireSubject(model, patch.subjectId, "constraint");
  const merged = parseOr(ConstraintSchema, { ...current, ...patch, id }, "constraint");
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
  const observation = parseOr(ObservationSchema, { dateOrPeriod: "", subjectId: "", evidenceSource: "", notes: "", ...input, id }, "observation");
  validateLinks(model, observation.links);
  return commit({ ...model, observations: [...model.observations, observation] });
}

export function updateObservation(model: SystemModel, id: string, patch: Partial<Omit<Observation, "id">>): SystemModel {
  const current = requireObservation(model, id);
  const merged = parseOr(ObservationSchema, { ...current, ...patch, id }, "observation");
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
      | "id"
      | "kind"
      | "loopId"
      | "subjectId"
      | "relationshipIds"
      | "supportingObservationIds"
      | "contradictingObservationIds"
      | "status"
      | "notes"
      | "disconfirmingConditions"
      | "predictions"
      | "killCriteria"
    >
  >;

function validateHypothesisRefs(model: SystemModel, h: Hypothesis): void {
  requireSubject(model, h.subjectId, "hypothesis");
  for (const id of h.relationshipIds) requireRelationship(model, id);
  for (const p of h.predictions) if (p.variableId) requireVariable(model, p.variableId);
  for (const k of h.killCriteria) {
    if (k.variableId) requireVariable(model, k.variableId);
    for (const o of k.observationIds) requireObservation(model, o);
  }
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
  const hypothesis = parseOr(HypothesisSchema, {
    kind: "general",
    relationshipIds: [],
    supportingObservationIds: [],
    contradictingObservationIds: [],
    status: "proposed",
    notes: "",
    ...input,
    id,
  }, "hypothesis");
  validateHypothesisRefs(model, hypothesis);
  return commit({ ...model, hypotheses: [...model.hypotheses, hypothesis] });
}

export function updateHypothesis(model: SystemModel, id: string, patch: Partial<Omit<Hypothesis, "id">>): SystemModel {
  const current = requireHypothesis(model, id);
  const merged = parseOr(HypothesisSchema, { ...current, ...patch, id }, "hypothesis");
  validateHypothesisRefs(model, merged);
  return commit({ ...model, hypotheses: model.hypotheses.map((h) => (h.id === id ? merged : h)) });
}

/** Change status and append a review-log entry (the reason is the person's). */
export function setHypothesisStatus(
  model: SystemModel,
  id: string,
  status: HypothesisStatus,
  review: { at: string; note?: string } = { at: "" },
): SystemModel {
  const h = requireHypothesis(model, id);
  const entry = { at: review.at, status, note: review.note ?? "" };
  return updateHypothesis(model, id, { status, reviewLog: [...h.reviewLog, entry] });
}

export function addDisconfirmingCondition(model: SystemModel, id: string, condition: string): SystemModel {
  const h = requireHypothesis(model, id);
  const text = condition.trim();
  if (!text) throw new MutationError("A disconfirming condition needs text");
  return updateHypothesis(model, id, { disconfirmingConditions: [...h.disconfirmingConditions, text] });
}

export function removeDisconfirmingCondition(model: SystemModel, id: string, index: number): SystemModel {
  const h = requireHypothesis(model, id);
  return updateHypothesis(model, id, { disconfirmingConditions: h.disconfirmingConditions.filter((_, i) => i !== index) });
}

export function addKillCriterion(
  model: SystemModel,
  hypothesisId: string,
  input: Omit<KillCriterion, "id" | "status" | "observationIds"> & Partial<Pick<KillCriterion, "id" | "observationIds">>,
): SystemModel {
  const h = requireHypothesis(model, hypothesisId);
  const id = input.id ?? `${hypothesisId}_kc_${h.killCriteria.length + 1}`;
  if (h.killCriteria.some((k) => k.id === id)) throw new MutationError(`Kill criterion "${id}" already exists`);
  return updateHypothesis(model, hypothesisId, {
    killCriteria: [...h.killCriteria, { status: "open", observationIds: [], ...input, id }],
  });
}

/** The PERSON records a criterion as triggered or cleared, citing observations. */
export function setKillCriterionStatus(
  model: SystemModel,
  hypothesisId: string,
  criterionId: string,
  status: KillCriterion["status"],
  observationIds: string[] = [],
): SystemModel {
  const h = requireHypothesis(model, hypothesisId);
  if (!h.killCriteria.some((k) => k.id === criterionId)) throw new MutationError(`Unknown kill criterion "${criterionId}"`);
  return updateHypothesis(model, hypothesisId, {
    killCriteria: h.killCriteria.map((k) => (k.id === criterionId ? { ...k, status, observationIds: [...new Set([...k.observationIds, ...observationIds])] } : k)),
  });
}

/** Engine READING of a numeric criterion against the variable's value:
 *  "triggered" / "cleared" / "unknown". It never writes the status. */
export function readKillCriterion(model: SystemModel, criterion: KillCriterion): "triggered" | "cleared" | "unknown" {
  if (!criterion.variableId || !criterion.comparator || criterion.threshold === undefined) return "unknown";
  const v = model.variables.find((x) => x.id === criterion.variableId);
  if (!v || v.currentValue === null) return "unknown";
  const x = v.currentValue;
  const t = criterion.threshold;
  const hit =
    criterion.comparator === "lt" ? x < t : criterion.comparator === "lte" ? x <= t : criterion.comparator === "gt" ? x > t : x >= t;
  return hit ? "triggered" : "cleared";
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
/* Events, shocks, interventions                                       */
/* ------------------------------------------------------------------ */

export type EventInput = Pick<Event, "kind" | "type" | "title" | "occurred" | "recordedAt" | "sourceType" | "confidence"> &
  Partial<Pick<Event, "id" | "description" | "subjectId" | "observationIds" | "links" | "status" | "expected" | "outcomeEventIds" | "notes">>;

function validateEventRefs(model: SystemModel, e: Event): void {
  requireSubject(model, e.subjectId, "event");
  for (const id of e.observationIds) requireObservation(model, id);
  for (const id of e.links.variableIds) requireVariable(model, id);
  for (const id of e.links.relationshipIds) requireRelationship(model, id);
  for (const id of e.links.hypothesisIds) requireHypothesis(model, id);
  for (const id of e.links.actionIds) if (!model.actions.some((a) => a.id === id)) throw new MutationError(`Unknown action "${id}"`);
  for (const id of e.links.incomeSourceIds) if (!model.incomeSources.some((s) => s.id === id)) throw new MutationError(`Unknown income source "${id}"`);
  for (const id of [...e.links.eventIds, ...e.outcomeEventIds]) {
    if (id !== e.id && !model.events.some((x) => x.id === id)) throw new MutationError(`Unknown event "${id}"`);
  }
  for (const x of e.expected) requireVariable(model, x.variableId);
  if (e.kind === "intervention" && !e.status) throw new MutationError("An intervention needs a status");
}

export function addEvent(model: SystemModel, input: EventInput): SystemModel {
  const id = input.id ?? nextId(model, "evt");
  if (model.events.some((e) => e.id === id)) throw new MutationError(`Event "${id}" already exists`);
  const event = parseOr(EventSchema, { description: "", subjectId: null, observationIds: [], expected: [], outcomeEventIds: [], notes: "", ...input, id }, "event");
  validateEventRefs(model, event);
  return commit({ ...model, events: [...model.events, event] });
}

export function updateEvent(model: SystemModel, id: string, patch: Partial<Omit<Event, "id">>): SystemModel {
  const current = model.events.find((e) => e.id === id);
  if (!current) throw new MutationError(`Unknown event "${id}"`);
  const merged = parseOr(EventSchema, { ...current, ...patch, id }, "event");
  validateEventRefs(model, merged);
  return commit({ ...model, events: model.events.map((e) => (e.id === id ? merged : e)) });
}

/** Events are history: removal only unlinks them from other events. */
export function removeEvent(model: SystemModel, id: string): SystemModel {
  if (!model.events.some((e) => e.id === id)) throw new MutationError(`Unknown event "${id}"`);
  return commit({
    ...model,
    events: model.events
      .filter((e) => e.id !== id)
      .map((e) => ({ ...e, links: { ...e.links, eventIds: e.links.eventIds.filter((x) => x !== id) }, outcomeEventIds: e.outcomeEventIds.filter((x) => x !== id) })),
  });
}

/* ------------------------------------------------------------------ */
/* Action extensions (versioned envelope)                              */
/* ------------------------------------------------------------------ */

/** Attach or replace a domain module's payload on an action. The core
 *  validates only the envelope; the module owns the payload. */
export function setActionExtension(model: SystemModel, actionId: string, domainId: string, envelope: ExtensionEnvelope): SystemModel {
  const a = model.actions.find((x) => x.id === actionId);
  if (!a) throw new MutationError(`Unknown action "${actionId}"`);
  if (!Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1) throw new MutationError("An extension needs a positive integer schemaVersion");
  return commit({
    ...model,
    actions: model.actions.map((x) => (x.id === actionId ? { ...x, extensions: { ...x.extensions, [domainId]: envelope } } : x)),
  });
}

export function removeActionExtension(model: SystemModel, actionId: string, domainId: string): SystemModel {
  const a = model.actions.find((x) => x.id === actionId);
  if (!a) throw new MutationError(`Unknown action "${actionId}"`);
  const extensions = { ...a.extensions };
  delete extensions[domainId];
  return commit({ ...model, actions: model.actions.map((x) => (x.id === actionId ? { ...x, extensions } : x)) });
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
