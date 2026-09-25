/**
 * The mutation REGISTRY: the only way a proposal touches the model. Each
 * kind names an existing pure mutation in src/services/mutations. The
 * registry checks serializable SHAPE only; the mutation itself is the
 * authoritative validation during dry-run. `materialize` freezes every
 * implicit value (ids, clocks) so the reviewed request is the approved
 * request. Step 1 registers ONLY kinds whose inputs materialize fully and
 * whose consequence is ordinary.
 */
import * as M from "@/services/mutations";
import type { ConstraintInput, EventInput, HypothesisInput, ObservationInput, RecordTargetInput, RecordValueInput, RelationshipInput, VariableInput } from "@/services/mutations";
import type { KillCriterion, SystemModel } from "@/types";
import type { ConsequenceClass, EntityChange, SemanticChange } from "./types";

export type MutationStep =
  | { kind: "addObservation"; args: ObservationInput }
  | { kind: "addHypothesis"; args: HypothesisInput }
  | { kind: "addEvent"; args: EventInput }
  | { kind: "addVariable"; args: VariableInput }
  | { kind: "addMember"; args: { id?: string; label: string; role?: string } }
  | { kind: "addRelationship"; args: RelationshipInput }
  | { kind: "addConstraint"; args: ConstraintInput }
  | { kind: "recordValue"; args: { variableId: string; input: RecordValueInput } }
  | { kind: "recordTarget"; args: { variableId: string; input: RecordTargetInput } }
  | { kind: "linkObservation"; args: { observationId: string; target: M.LinkTarget } }
  | { kind: "attachObservationToHypothesis"; args: { hypothesisId: string; observationId: string; role: "supporting" | "contradicting" } }
  | { kind: "addDisconfirmingCondition"; args: { hypothesisId: string; condition: string } }
  | { kind: "addKillCriterion"; args: { hypothesisId: string; input: Omit<KillCriterion, "id" | "status" | "observationIds"> & Partial<Pick<KillCriterion, "id" | "observationIds">> } };

export type MutationKind = MutationStep["kind"];
type ArgsOf<K extends MutationKind> = Extract<MutationStep, { kind: K }>["args"];

export interface Clock {
  now: () => string;
}

export interface RegistryEntry<K extends MutationKind = MutationKind> {
  /** Serializable-shape check: required keys and primitive types only. null = fine. */
  shape: (args: unknown) => string | null;
  /** Freeze ids and clocks against the working model. Pure. */
  materialize: (args: ArgsOf<K>, model: SystemModel, clock: Clock) => ArgsOf<K>;
  /** Delegates to the canonical mutation. */
  apply: (model: SystemModel, args: ArgsOf<K>) => SystemModel;
  /** Ids of the entities the step names (created or targeted), so the kernel can tell "nothing else changes". */
  names: (args: ArgsOf<K>) => { collection: string; id: string }[];
  /** Outputs the mutation still derives from state, read from the diff. */
  expectedOutputs: (args: ArgsOf<K>, changes: EntityChange[]) => Record<string, string>;
  /** Ordinary-language description built ON the diff. */
  describe: (args: ArgsOf<K>, changes: EntityChange[], before: SystemModel, after: SystemModel) => SemanticChange[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** Plain data only: a Date or class instance serializes to something other than itself. */
const isPlainObject = (x: unknown): x is Record<string, unknown> => isRecord(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const isJsonValue = (x: unknown): boolean => x === null || ["string", "boolean"].includes(typeof x) || (typeof x === "number" && Number.isFinite(x)) || (Array.isArray(x) && x.every(isJsonValue)) || (isPlainObject(x) && Object.values(x).every(isJsonValue));
function requireKeys(args: unknown, keys: string[]): string | null {
  if (!isRecord(args)) return "arguments must be an object";
  if (!isJsonValue(args)) return "arguments must be plain JSON (no functions, dates or undefined)";
  for (const k of keys) if (!(k in args)) return `missing "${k}"`;
  return null;
}
const nameOf = (model: SystemModel, id: string) => model.variables.find((v) => v.id === id)?.name ?? id;
const subjectOf = (model: SystemModel, id: string | null | undefined) => (id == null ? undefined : id === model.id ? model.profile.name : (model.profile.members.find((m) => m.id === id)?.label ?? id));
const q = (s: string) => `“${s}”`;
const entryIdsOf = (changes: EntityChange[], collection: string, id: string, field: "values" | "targets"): string[] => {
  const row = changes.find((c) => c.collection === collection && c.id === id);
  if (!row) return [];
  const before = new Set((((row.before as Record<string, unknown> | undefined)?.[field] as { id: string }[] | undefined) ?? []).map((e) => e.id));
  return ((((row.after as Record<string, unknown> | undefined)?.[field] as { id: string }[] | undefined) ?? []).map((e) => e.id)).filter((x) => !before.has(x));
};

export const REGISTRY: { [K in MutationKind]: RegistryEntry<K> } = {
  addObservation: {
    shape: (a) => requireKeys(a, ["statement", "sourceType", "confidence"]),
    materialize: (a, m) => ({ ...a, id: a.id ?? M.nextId(m, "obs") }),
    apply: (m, a) => M.addObservation(m, a),
    names: (a) => [{ collection: "observations", id: a.id as string }],
    expectedOutputs: () => ({}),
    describe: (a, _c, _b, after) => [{ verb: "create", noun: "observation", summary: `Record observation ${q(a.statement)}.`, subject: subjectOf(after, a.subjectId), details: [`Source: ${a.sourceType.replace("_", " ")} · confidence ${Math.round(a.confidence * 100)}%.`, a.dateOrPeriod ? `When: ${a.dateOrPeriod}.` : "No date given."] }],
  },
  addHypothesis: {
    // confidence is optional / number / null: omitted = not assessed; the mutation validates the number
    shape: (a) => requireKeys(a, ["statement"]),
    materialize: (a, m) => ({ ...a, id: a.id ?? M.nextId(m, "hyp") }),
    apply: (m, a) => M.addHypothesis(m, a),
    names: (a) => [{ collection: "hypotheses", id: a.id as string }],
    expectedOutputs: () => ({}),
    describe: (a, _c, _b, after) => [{ verb: "create", noun: "hypothesis", summary: `Create hypothesis ${q(a.statement)}.`, subject: subjectOf(after, a.subjectId), details: [`Status: ${a.status ?? "proposed"}.`, a.confidence === undefined || a.confidence === null ? "Confidence: not assessed." : `Confidence: ${Math.round(a.confidence * 100)}%.`, ...(a.disconfirmingConditions?.length ? [`Would be reconsidered if: ${a.disconfirmingConditions.join("; ")}.`] : ["No disconfirming condition stated yet."]), ...(a.predictions?.length ? [`${a.predictions.length} prediction${a.predictions.length > 1 ? "s" : ""}.`] : [])] }],
  },
  addEvent: {
    shape: (a) => requireKeys(a, ["kind", "type", "title", "occurred", "recordedAt", "sourceType", "confidence"]),
    materialize: (a, m) => ({ ...a, id: a.id ?? M.nextId(m, "evt") }),
    apply: (m, a) => M.addEvent(m, a),
    names: (a) => [{ collection: "events", id: a.id as string }],
    expectedOutputs: () => ({}),
    describe: (a, _c, _b, after) => [{ verb: "record", noun: "event", summary: `Record event ${q(a.title)} (${a.kind}).`, subject: subjectOf(after, a.subjectId), details: [`When: ${a.occurred.text || a.occurred.start || "unknown time"}.`] }],
  },
  addVariable: {
    shape: (a) => requireKeys(a, ["name", "category", "changeSpeed", "unit", "subjectId"]),
    materialize: (a, m, clock) => ({ ...a, id: a.id ?? M.nextId(m, "var"), ...(a.currentValue !== undefined ? { recordedAt: a.recordedAt ?? clock.now() } : {}) }),
    apply: (m, a) => M.addVariable(m, a),
    names: (a) => [{ collection: "variables", id: a.id as string }],
    expectedOutputs: (a, changes) => Object.fromEntries(entryIdsOf(changes, "variables", a.id as string, "values").map((id, i) => [`valueEntry${i}`, id])),
    describe: (a, _c, _b, after) => [{ verb: "create", noun: "variable", summary: `Add variable ${q(a.name)}${a.currentValue !== undefined ? ` with value ${a.currentValue} ${a.unit}` : " with no value yet"}.`, subject: a.subjectId === null ? "unassigned" : subjectOf(after, a.subjectId), details: [`Category ${a.category}, ${a.changeSpeed} changing.`] }],
  },
  addMember: {
    shape: (a) => requireKeys(a, ["label"]),
    materialize: (a, m) => ({ ...a, id: a.id ?? M.nextId(m, "member") }),
    apply: (m, a) => M.addMember(m, a),
    names: (a) => [{ collection: "profile.members", id: a.id as string }],
    expectedOutputs: () => ({}),
    describe: (a) => [{ verb: "create", noun: "subject", summary: `Add ${q(a.label)} as a subject of the system.`, details: a.role ? [`Role: ${a.role}.`] : [] }],
  },
  addRelationship: {
    shape: (a) => requireKeys(a, ["sourceVariableId", "targetVariableId", "direction", "strength", "lag", "confidence", "sourceType", "kind"]),
    materialize: (a, m) => ({ ...a, id: a.id ?? M.nextId(m, "rel") }),
    apply: (m, a) => M.addRelationship(m, a),
    names: (a) => [{ collection: "relationships", id: a.id as string }],
    expectedOutputs: () => ({}),
    describe: (a, _c, before) => [{ verb: "link", noun: "relationship", summary: `Add a ${a.kind.replace("_", " ")} edge from ${q(nameOf(before, a.sourceVariableId))} to ${q(nameOf(before, a.targetVariableId))} (${a.direction}).`, details: [`Strength ${a.strength}, lag ${a.lag.value} ${a.lag.unit}, confidence ${Math.round(a.confidence * 100)}%.`, a.participatesInDynamics ? "Takes part in loops and propagation." : "Does not take part in dynamics."] }],
  },
  addConstraint: {
    shape: (a) => requireKeys(a, ["name", "type", "sourceType", "confidence"]),
    materialize: (a, m) => ({ ...a, id: a.id ?? M.nextId(m, "con") }),
    apply: (m, a) => M.addConstraint(m, a),
    names: (a) => [{ collection: "constraints", id: a.id as string }],
    expectedOutputs: () => ({}),
    describe: (a, _c, _b, after) => [{ verb: "create", noun: "constraint", summary: `Add ${a.type} constraint ${q(a.name)}.`, subject: subjectOf(after, a.subjectId), details: [a.check ? `Checked as ${a.check.dimension} ${a.check.comparator} ${String(a.check.limit)}.` : "Not machine-checked; reported as unchecked."] }],
  },
  recordValue: {
    shape: (a) => requireKeys(a, ["variableId", "input"]),
    materialize: (a, _m, clock) => ({ ...a, input: { ...a.input, recordedAt: a.input.recordedAt ?? clock.now() } }),
    apply: (m, a) => M.recordValue(m, a.variableId, a.input),
    names: (a) => [{ collection: "variables", id: a.variableId }],
    expectedOutputs: (a, changes) => Object.fromEntries(entryIdsOf(changes, "variables", a.variableId, "values").map((id, i) => [`valueEntry${i}`, id])),
    describe: (a, _c, before) => [{ verb: "record", noun: `value of ${nameOf(before, a.variableId)}`, summary: `Record ${a.input.value === null ? "an unknown value" : `${a.input.value} ${before.variables.find((v) => v.id === a.variableId)?.unit ?? ""}`.trim()} for ${q(nameOf(before, a.variableId))}.`, details: [`Applies ${a.input.valid ? a.input.valid.text || a.input.valid.start || "as stated" : `from its recording (${a.input.recordedAt})`}; source ${a.input.sourceType.replace("_", " ")}, confidence ${a.input.confidence === null ? "not assessed" : `${Math.round(a.input.confidence * 100)}%`}.`, "Earlier values stay in the history."] }],
  },
  recordTarget: {
    shape: (a) => requireKeys(a, ["variableId", "input"]),
    materialize: (a, _m, clock) => ({ ...a, input: { ...a.input, recordedAt: a.input.recordedAt ?? clock.now() } }),
    apply: (m, a) => M.recordTarget(m, a.variableId, a.input),
    names: (a) => [{ collection: "variables", id: a.variableId }],
    expectedOutputs: (a, changes) => Object.fromEntries(entryIdsOf(changes, "variables", a.variableId, "targets").map((id, i) => [`targetEntry${i}`, id])),
    describe: (a, _c, before) => [{ verb: "record", noun: `target of ${nameOf(before, a.variableId)}`, summary: `Record target ${a.input.desiredValue === null ? "cleared" : `${a.input.desiredValue} (${a.input.targetMode ?? "as before"})`} for ${q(nameOf(before, a.variableId))}.`, details: ["Earlier targets stay in the history."] }],
  },
  linkObservation: {
    shape: (a) => requireKeys(a, ["observationId", "target"]),
    materialize: (a) => a,
    apply: (m, a) => M.linkObservation(m, a.observationId, a.target),
    names: (a) => [{ collection: "observations", id: a.observationId }],
    expectedOutputs: () => ({}),
    describe: (a, _c, before) => [{ verb: "link", noun: "observation", summary: `Link observation ${q(before.observations.find((o) => o.id === a.observationId)?.statement ?? a.observationId)} to ${a.target.kind} ${a.target.id}.`, details: ["A link records relevance; it does not make the observation support or contradict anything."] }],
  },
  attachObservationToHypothesis: {
    shape: (a) => requireKeys(a, ["hypothesisId", "observationId", "role"]),
    materialize: (a) => a,
    apply: (m, a) => M.attachObservationToHypothesis(m, a.hypothesisId, a.observationId, a.role),
    names: (a) => [{ collection: "hypotheses", id: a.hypothesisId }],
    expectedOutputs: () => ({}),
    describe: (a, _c, before) => [{ verb: "link", noun: "evidence", summary: `Mark observation ${q(before.observations.find((o) => o.id === a.observationId)?.statement ?? a.observationId)} as ${a.role} the hypothesis ${q(before.hypotheses.find((h) => h.id === a.hypothesisId)?.statement ?? a.hypothesisId)}.`, details: ["The person's judgment of bearing; the observation itself is unchanged."] }],
  },
  addDisconfirmingCondition: {
    shape: (a) => requireKeys(a, ["hypothesisId", "condition"]),
    materialize: (a) => a,
    apply: (m, a) => M.addDisconfirmingCondition(m, a.hypothesisId, a.condition),
    names: (a) => [{ collection: "hypotheses", id: a.hypothesisId }],
    expectedOutputs: () => ({}),
    describe: (a, _c, before) => [{ verb: "change", noun: "hypothesis", summary: `Add a reconsider-if condition to ${q(before.hypotheses.find((h) => h.id === a.hypothesisId)?.statement ?? a.hypothesisId)}: ${q(a.condition)}.`, details: [] }],
  },
  addKillCriterion: {
    shape: (a) => requireKeys(a, ["hypothesisId", "input"]),
    materialize: (a, m) => ({ ...a, input: { ...a.input, id: a.input.id ?? `${a.hypothesisId}_kc_${(m.hypotheses.find((h) => h.id === a.hypothesisId)?.killCriteria.length ?? 0) + 1}` } }),
    apply: (m, a) => M.addKillCriterion(m, a.hypothesisId, a.input),
    names: (a) => [{ collection: "hypotheses", id: a.hypothesisId }],
    expectedOutputs: () => ({}),
    describe: (a, _c, before) => [{ verb: "change", noun: "hypothesis", summary: `Add a decision rule to ${q(before.hypotheses.find((h) => h.id === a.hypothesisId)?.statement ?? a.hypothesisId)}: ${q(a.input.statement)}.`, details: ["The engine will report it triggered or cleared; only the person changes the hypothesis."] }],
  },
};

export const REGISTERED_KINDS = Object.keys(REGISTRY) as MutationKind[];
export function isRegisteredKind(kind: string): kind is MutationKind {
  return Object.prototype.hasOwnProperty.call(REGISTRY, kind);
}
export function entry<K extends MutationKind>(kind: K): RegistryEntry<K> {
  return REGISTRY[kind] as unknown as RegistryEntry<K>;
}

/**
 * CONSEQUENCE CLASSIFICATION — a pure, pinned table over EVERY canonical
 * mutation kind (registered or not), by kind and content. Never chosen by
 * the proposer. readKillCriterion is absent: it reads and never writes.
 */
export const CONSEQUENTIAL_KINDS = new Set([
  "removeMember", "archiveMember", "restoreMember", "assignVariableSubject",
  "removeVariable", "retractValue", "retractTarget", "correctValue", "correctTarget",
  "removeRelationship", "setRelationshipKind", "setRelationshipDynamics",
  "removeConstraint", "updateConstraint",
  "removeObservation", "unlinkObservation",
  "removeHypothesis", "setHypothesisStatus", "setKillCriterionStatus", "removeDisconfirmingCondition", "detachObservationFromHypothesis",
  "removeEvent", "removeCollectionItem", "removeSignatureSnapshot", "removeActionExtension",
]);
export const ORDINARY_KINDS = new Set([
  "updateProfile", "addMember", "updateMember", "setCurrentAttractor", "setDesiredAttractor", "addCollectionItem", "updateCollectionItem",
  "addVariable", "recordValue", "recordTarget", "updateVariable", "addRelationship", "updateRelationship", "setRelationshipEnabled", "setLoopAnnotation",
  "addConstraint", "addObservation", "updateObservation", "linkObservation", "addHypothesis", "updateHypothesis", "addDisconfirmingCondition",
  "addKillCriterion", "attachObservationToHypothesis", "addEvent", "updateEvent", "setActionExtension", "addSignatureSnapshot", "updateSignatureMeta",
]);

/** Ordinary-language reasons a materialized step is consequential, for the
 *  second confirmation to NAME. Same rules as consequenceOf, by content. */
export function consequenceReasons(kind: string, args: unknown): string[] {
  const a = isRecord(args) ? args : {};
  const out: string[] = [];
  if (kind === "addConstraint" && a.type === "hard" && !a.check) out.push(`“${String(a.name ?? "this constraint")}” becomes a HARD constraint the engine cannot check: every action it names will be reported as violating it until a person says otherwise.`);
  if (kind === "updateHypothesis" && typeof a.patch === "object" && a.patch !== null && "statement" in (a.patch as object)) out.push("The hypothesis statement itself changes; every observation attached to it was attached to the old wording.");
  if (CONSEQUENTIAL_KINDS.has(kind)) out.push(`“${kind}” removes, corrects, reassigns or re-judges recorded material; the record after this change no longer says what it said before.`);
  if (!CONSEQUENTIAL_KINDS.has(kind) && !ORDINARY_KINDS.has(kind)) out.push(`“${kind}” is not a known mutation; it is treated as consequential.`);
  return out;
}

export function consequenceOf(kind: string, args: unknown, model: SystemModel): ConsequenceClass {
  if (CONSEQUENTIAL_KINDS.has(kind)) return "consequential";
  const a = isRecord(args) ? args : {};
  // content rules
  if (kind === "addConstraint" && a.type === "hard" && !a.check) return "consequential"; // a commitment (class 3)
  if (kind === "updateHypothesis" && typeof a.patch === "object" && a.patch !== null && "statement" in (a.patch as object)) return "consequential";
  if (kind === "updateCollectionItem" && isRecord(a.patch)) {
    const def = model.collections[a.collection as string];
    void def;
    if (Object.keys(a.patch).some((k) => /Id$/.test(k))) return "consequential"; // a subject field change
  }
  if (ORDINARY_KINDS.has(kind)) return "ordinary";
  return "consequential"; // unknown kinds are treated as consequential, never as ordinary
}
