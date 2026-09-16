/**
 * AI CONTEXT BUILDER (Step 5B). Deterministic, inspectable, task-scoped.
 *
 *   selected evidence -> inspectable deterministic context -> (later) AI interpretation
 *
 * The AI never receives an arbitrary model dump. buildAiContext(model,
 * task, selection) returns the least context the task needs, every item
 * carrying a TYPED reference and its provenance (directly recorded /
 * carried forward / calculated / explicit unknown / ambiguous), stored
 * judgments labelled as judgments, a manifest saying what was included,
 * excluded and why, and a contextHash over the canonical CONTENT (never
 * the wall clock). Deterministic engine outputs (History facts, the
 * Explore comparison) enter as items; the AI is never asked to recompute
 * them. No provider, no network, no AI output schema lives here.
 *
 * THREE IDENTITIES (Step 5C), never conflated:
 *   sourceRevisionHash  which local model state the context was built from (LOCAL audit only)
 *   contextHash         hash(canonical(providerPayload)): exactly what a provider would receive
 *   output item id      (later) which AI interpretation a proposal came from
 * The provider payload is the ONLY object a provider may receive: task and
 * items. The manifest (what was excluded and why), the source revision and
 * builtAt are local audit information and never cross that boundary.
 * SENSITIVITY IS TRANSITIVE: a sensitive variable is withheld directly and
 * through every composite item that carries it (derived, relationship,
 * pattern, Explore comparison, hypothesis, observation links) unless the
 * call explicitly includes sensitive material; a composite is withheld
 * WHOLE, never trimmed (a trimmed comparison would misstate the engine).
 *
 * Epistemic vocabulary for later AI output (never mapped to numbers):
 *   directly_stated  the supplied source explicitly says it (NOT true, verified or certain)
 *   interpretive     a reading of the source, named as such
 *   tentative        an interpretation without direct support
 *   unresolved       cannot be told from the context
 */
import { temporalInterval } from "@/calculations/time";
import { contextSubjectsFor, crossContext, type CrossContext, type PatternRef } from "@/discovery/cross-context";
import { describeVariableHistory } from "@/discovery/describe-history";
import { extentInstants, type IntervalRequest } from "@/discovery/interval";
import { encodePatternRef } from "@/discovery/pattern-ref";
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import { normalizeInstant, resolveVariableAt } from "@/model/history";
import type { StoredVariable, SystemModel, Variable } from "@/types";

/* ------------------------------------------------------------------ */
/* Epistemic vocabulary (for the later output contract)                */
/* ------------------------------------------------------------------ */

export const EPISTEMIC_STATES = ["directly_stated", "interpretive", "tentative", "unresolved"] as const;
export type EpistemicState = (typeof EPISTEMIC_STATES)[number];

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export const AI_TASKS = ["extract_statements", "interpret_free_text", "suggest_explanations_for_pattern", "suggest_questions_to_reduce_uncertainty", "summarize_model", "propose_observation_from_user_statement"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export type ContextItemKind = "system" | "variable" | "value" | "variable_history" | "derived" | "observation" | "event" | "relationship" | "constraint" | "hypothesis" | "pattern" | "cross_context" | "catalogue_prompt" | "user_text";

/** What each task may receive: an explicit allowlist of item kinds and a subject-scope rule. */
export interface TaskPolicy {
  kinds: readonly ContextItemKind[];
  /** subject: the selected subject plus the system. pattern: contextSubjectsFor(pattern). selected: selection.subjectIds plus the system. */
  scope: "subject" | "pattern" | "selected";
  requires: readonly ("userText" | "pattern")[];
}

export const TASK_POLICIES: Record<AiTask, TaskPolicy> = {
  extract_statements: { kinds: ["system", "variable", "user_text"], scope: "subject", requires: ["userText"] },
  propose_observation_from_user_statement: { kinds: ["system", "user_text"], scope: "subject", requires: ["userText"] },
  interpret_free_text: { kinds: ["system", "variable", "value", "derived", "observation", "user_text"], scope: "subject", requires: ["userText"] },
  suggest_explanations_for_pattern: { kinds: ["system", "pattern", "cross_context", "catalogue_prompt", "observation", "event"], scope: "pattern", requires: ["pattern"] },
  suggest_questions_to_reduce_uncertainty: { kinds: ["system", "variable", "value", "derived", "hypothesis"], scope: "subject", requires: [] },
  summarize_model: { kinds: ["system", "variable", "value", "derived", "relationship", "constraint", "hypothesis", "observation", "event"], scope: "selected", requires: [] },
};

/* ------------------------------------------------------------------ */
/* Typed references                                                    */
/* ------------------------------------------------------------------ */

export type ContextRef =
  | { kind: "system"; id: string }
  | { kind: "variable"; id: string }
  | { kind: "value"; variableId: string; asOf: string }
  | { kind: "variable_history"; variableId: string; from: string; to: string }
  | { kind: "derived"; variableId: string; asOf: string }
  | { kind: "observation"; id: string }
  | { kind: "event"; id: string }
  | { kind: "relationship"; id: string }
  | { kind: "constraint"; id: string }
  | { kind: "hypothesis"; id: string }
  | { kind: "pattern"; pattern: PatternRef }
  | { kind: "cross_context"; pattern: PatternRef }
  | { kind: "catalogue_prompt"; domainId: string; domainVersion: number; promptId: string }
  | { kind: "user_text"; textHash: string };

/** Canonical string id for transport and display. Code never reparses it; the typed ref is the truth. */
export function refId(ref: ContextRef): string {
  switch (ref.kind) {
    case "system":
    case "variable":
    case "observation":
    case "event":
    case "relationship":
    case "constraint":
    case "hypothesis":
      return `${ref.kind}:${ref.id}`;
    case "value":
    case "derived":
      return `${ref.kind}:${ref.variableId}@${ref.asOf}`;
    case "variable_history":
      return `variable_history:${ref.variableId}:${ref.from}→${ref.to}`;
    case "pattern":
    case "cross_context":
      return `${ref.kind}:${encodePatternRef(ref.pattern)}`;
    case "catalogue_prompt":
      return `catalogue_prompt:${ref.domainId}@${ref.domainVersion}:${ref.promptId}`;
    case "user_text":
      return `user_text:${ref.textHash}`;
  }
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

/** How a value the AI sees came to be. Never "a fact". */
export type ValueBasis = "recorded_here" | "carried_forward" | "calculated" | "explicit_unknown" | "ambiguous" | "unknown";

export const STORED_JUDGMENT_NOTE = "stored model judgments entered by a person (ordinal, 0..1); not measurements, not facts";

export interface ContextItem {
  ref: ContextRef;
  id: string;
  kind: ContextItemKind;
  subjectId: string | null;
  payload: Record<string, unknown>;
}

export interface AiContextManifest {
  task: AiTask;
  included: Partial<Record<ContextItemKind, number>>;
  subjectsIncluded: string[];
  subjectsExcluded: { id: string; reason: string }[];
  /** What was deliberately left out, in words. */
  exclusions: string[];
  /** Sensitive items (domain-configured) left out; present only when not explicitly included. */
  sensitiveExcluded: string[];
  /** Plain words for composite items withheld because a constituent is sensitive. */
  withheld: string[];
  /** Length of the canonical provider payload. */
  approxChars: number;
}

/** The ONLY object a provider may receive. No manifest, no revision, no clock, no exclusion bookkeeping. */
export interface AiProviderPayload {
  version: 1;
  task: AiTask;
  items: ContextItem[];
}

export interface AiContext {
  task: AiTask;
  systemId: string;
  items: ContextItem[];
  /** LOCAL audit: what was left out and why. Never sent. */
  manifest: AiContextManifest;
  /** LOCAL audit: digest of the kernel revision (contentHash of revisionOf(model)). Never sent, never hashed into contextHash. */
  sourceRevisionHash: string;
  /** hash(canonical(providerPayload(this))): identical provider-visible payload -> identical hash. */
  contextHash: string;
  /** Metadata only: never sent, never hashed. */
  builtAt: string;
}

/** The identity a future LOCAL call record carries, so AI content origin can
 *  be recorded independently of ProposalAuthor. Only contextHash is
 *  provider-visible. Never canonical model state. */
export interface AiCallIdentity {
  task: AiTask;
  contextHash: string;
  sourceRevisionHash: string;
}

/** The provider-visible payload: task and items only. Pure. */
export function providerPayload(ctx: Pick<AiContext, "task" | "items">): AiProviderPayload {
  return { version: 1, task: ctx.task, items: ctx.items };
}

/** contextHash = hash(canonical(providerPayload)). */
export function contextHashOf(payload: AiProviderPayload): string {
  return contentHash(canonical(payload));
}

export interface TaskSelection {
  /** The subject of a subject-scoped task (system id or member id). Defaults to the system. */
  subjectId?: string;
  /** Explicit subjects for summarize_model (the system is always included). */
  subjectIds?: string[];
  userText?: string;
  pattern?: PatternRef;
  /** For value / derived items (an ISO instant or date). REQUIRED by tasks
   *  that carry values: it is content, never defaulted from the clock. */
  asOf?: string;
  /** For variable_history items (used by summarize_model when given). */
  interval?: IntervalRequest;
  /** Restrict to these ids where the task allows the kind (observations, events, variables). */
  variableIds?: string[];
  observationIds?: string[];
  eventIds?: string[];
  /** Explicit per-call inclusion of domain-configured sensitive items. */
  includeSensitive?: boolean;
}

export interface BuildOptions {
  /** Metadata clock for `builtAt` only. Never part of the hash. */
  now?: string;
}

export class AiContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiContextError";
  }
}

/* ------------------------------------------------------------------ */
/* Canonical serialization and hash                                    */
/* ------------------------------------------------------------------ */

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** FNV-1a over UTF-16 code units, two independent 32-bit lanes -> 16 hex
 *  chars. An IDENTIFIER for call records and provenance, not a security
 *  primitive and not the kernel's revision (which stays exact text). */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((c * 31 + i) & 0xffff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

/** Digest of the kernel's revision (the exact canonical model minus updatedAt). */
export function sourceRevisionHashOf(model: SystemModel): string {
  const { updatedAt: _u, ...rest } = model;
  void _u;
  return contentHash(canonical(rest));
}

function valueBasisOf(stored: StoredVariable, resolved: Variable, asOf: string): ValueBasis {
  if (stored.kind === "derived") return "calculated";
  const state = resolved.valueResolution;
  if (state === "ambiguous") return "ambiguous";
  if (state !== "resolved" || !resolved.valueEntry) return "unknown";
  if (resolved.valueEntry.value === null) return "explicit_unknown";
  const raw = temporalInterval(resolved.valueEntry.valid);
  const extent = raw ? extentInstants(raw) : null;
  const at = normalizeInstant(asOf);
  return extent && extent.start <= at && extent.end >= at ? "recorded_here" : "carried_forward";
}

export function buildAiContext(model: SystemModel, task: AiTask, selection: TaskSelection = {}, options: BuildOptions = {}): AiContext {
  const policy = TASK_POLICIES[task];
  if (!policy) throw new AiContextError(`Unknown AI task "${String(task)}"`);
  for (const r of policy.requires) {
    if (r === "userText" && !selection.userText?.trim()) throw new AiContextError(`Task ${task} needs the person's text`);
    if (r === "pattern" && !selection.pattern) throw new AiContextError(`Task ${task} needs a pattern reference`);
  }
  const domain = domainRegistry.get(model.domainDefinitionId, model.domainDefinitionVersion);
  const memberIds = new Set(model.profile.members.map((m) => m.id));
  const subjectLabel = (id: string | null) => (id === null ? "unassigned" : id === model.id ? model.profile.name : (model.profile.members.find((m) => m.id === id)?.label ?? id));

  // ---- subject scope (deterministic per task) ----
  let scope: string[];
  let scopeReason: string;
  if (policy.scope === "pattern") {
    scope = contextSubjectsFor(model, selection.pattern as PatternRef, domain);
    scopeReason = "outside the pattern's deterministic Explore context scope";
  } else if (policy.scope === "selected") {
    const chosen = (selection.subjectIds ?? []).filter((id) => id === model.id || memberIds.has(id));
    scope = [...new Set([model.id, ...chosen])];
    scopeReason = "not selected for this summary";
  } else {
    const subject = selection.subjectId ?? model.id;
    if (subject !== model.id && !memberIds.has(subject)) throw new AiContextError(`Unknown subject "${subject}"`);
    scope = subject === model.id ? [model.id] : [subject, model.id];
    scopeReason = "another subject; not part of this task";
  }
  const scopeSet = new Set(scope);
  const inScope = (subjectId: string | null) => subjectId !== null && scopeSet.has(subjectId);
  const allows = (k: ContextItemKind) => policy.kinds.includes(k);
  const sensitiveKinds = new Set(domain?.aiContext?.sensitive?.itemKinds ?? []);
  const sensitiveKeys = new Set(domain?.aiContext?.sensitive?.variableKeys ?? []);
  const sensitiveVariableIds = new Set(model.variables.filter((v) => sensitiveKinds.has("variable") || sensitiveKeys.has(v.key)).map((v) => v.id));
  const sensitiveRelationshipIds = new Set(model.relationships.filter((r) => sensitiveKinds.has("relationship") || sensitiveVariableIds.has(r.sourceVariableId) || sensitiveVariableIds.has(r.targetVariableId)).map((r) => r.id));
  /** Everything an item carries that sensitivity can attach to. */
  interface Constituents {
    variableIds?: readonly string[];
    relationshipIds?: readonly string[];
    eventIds?: readonly string[];
    observationIds?: readonly string[];
    ownKind: ContextItemKind;
  }
  /** ONE deterministic sensitivity decision, applied before transport. */
  const isSensitive = (c: Constituents): boolean =>
    sensitiveKinds.has(c.ownKind) ||
    (c.variableIds ?? []).some((id) => sensitiveVariableIds.has(id)) ||
    (c.relationshipIds ?? []).some((id) => sensitiveRelationshipIds.has(id)) ||
    ((c.eventIds ?? []).length > 0 && sensitiveKinds.has("event")) ||
    ((c.observationIds ?? []).length > 0 && sensitiveKinds.has("observation"));
  const sensitiveExcluded: string[] = [];
  const withheld: string[] = [];
  const items: ContextItem[] = [];
  const push = (item: ContextItem, constituents: Constituents, withheldWords?: string) => {
    if (isSensitive(constituents) && !selection.includeSensitive) {
      sensitiveExcluded.push(item.id);
      if (withheldWords) withheld.push(withheldWords);
      return;
    }
    items.push(item);
  };
  // "Values as of" is CONTENT (it decides what resolves), so it must be an
  // explicit part of the selection; the wall clock never enters the hash.
  if ((allows("value") || allows("derived")) && !selection.asOf) throw new AiContextError(`Task ${task} needs an explicit "values as of" instant in the selection`);
  const asOf = selection.asOf ?? "";
  const wantVariable = (v: StoredVariable) => inScope(v.subjectId) && (!selection.variableIds || selection.variableIds.includes(v.id));
  const keyToId = new Map(model.variables.map((v) => [`${v.key}\u0000${v.subjectId ?? ""}`, v.id]));
  const idsForKeys = (keys: readonly string[], subjectId: string | null) => keys.flatMap((k) => [keyToId.get(`${k}\u0000${subjectId ?? ""}`), keyToId.get(`${k}\u0000${model.id}`)].filter((x): x is string => typeof x === "string"));

  // ---- system ----
  if (allows("system")) {
    push({ ref: { kind: "system", id: model.id }, id: refId({ kind: "system", id: model.id }), kind: "system", subjectId: model.id, payload: { name: model.profile.name, systemType: model.profile.systemType, domainId: model.domainDefinitionId, domainVersion: model.domainDefinitionVersion, subjects: scope.map((id) => ({ id, label: subjectLabel(id), role: id === model.id ? "system" : "member" })) } }, { ownKind: "system" });
  }

  // ---- variables, values, derived ----
  const evaluated = allows("value") || allows("derived") ? evaluateSystem(model, { asOf }) : null;
  const derivedById = new Map((evaluated?.derived ?? []).map((d) => [d.variable.id, d]));
  for (const v of [...model.variables].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!wantVariable(v)) continue;
    const own: Constituents = { ownKind: "variable", variableIds: [v.id] };
    if (allows("variable")) {
      const ref: ContextRef = { kind: "variable", id: v.id };
      push({ ref, id: refId(ref), kind: "variable", subjectId: v.subjectId, payload: { name: v.name, unit: v.unit, category: v.category, changeSpeed: v.changeSpeed, kind: v.kind, subject: subjectLabel(v.subjectId), storedJudgments: { note: STORED_JUDGMENT_NOTE, controllability: v.controllability, durability: v.durability, estimatedCostToChange: v.estimatedCostToChange, ...(v.impact !== undefined ? { impact: v.impact } : {}) } } }, own);
    }
    if (v.kind === "input" && allows("value")) {
      const resolved = resolveVariableAt(v, asOf);
      const basis = valueBasisOf(v, resolved, asOf);
      if (task === "suggest_questions_to_reduce_uncertainty" && basis === "recorded_here") continue; // only what is uncertain
      const ref: ContextRef = { kind: "value", variableId: v.id, asOf };
      push({ ref, id: refId(ref), kind: "value", subjectId: v.subjectId, payload: { variable: v.name, unit: v.unit, value: basis === "recorded_here" || basis === "carried_forward" ? resolved.currentValue : null, basis, resolution: resolved.valueResolution, ...(resolved.valueEntry ? { entryId: resolved.valueEntry.id, appliesFrom: temporalInterval(resolved.valueEntry.valid)?.start ?? null, validBasis: resolved.valueEntry.validBasis, sourceType: resolved.valueEntry.sourceType, storedConfidence: { note: STORED_JUDGMENT_NOTE, value: resolved.valueEntry.confidence } } : {}), ...(basis === "carried_forward" ? { note: "the resolver carries an earlier record forward; nothing was recorded at this instant" } : {}) } }, { ...own, ownKind: "value" });
    }
    if (v.kind === "derived" && allows("derived")) {
      const d = derivedById.get(v.id);
      if (!d) continue;
      if (task === "suggest_questions_to_reduce_uncertainty" && d.missingInputs.length === 0) continue;
      const ref: ContextRef = { kind: "derived", variableId: v.id, asOf };
      push({ ref, id: refId(ref), kind: "derived", subjectId: v.subjectId, payload: { variable: v.name, unit: v.unit, value: d.variable.currentValue, basis: "calculated" as ValueBasis, missingInputs: d.missingInputs, assumptionIds: d.definition.assumptionIds, formula: d.definition.description, minInputConfidence: d.variable.currentValue === null ? null : d.variable.confidence } }, { ownKind: "derived", variableIds: [v.id, ...idsForKeys([...d.definition.inputs, ...d.definition.derivedInputs].map((i) => i.key), v.subjectId)] }, `Calculated value “${v.name}” withheld because it reads a sensitive variable.`);
    }
  }

  // ---- observations, events ----
  if (allows("observation")) {
    for (const o of [...model.observations].sort((a, b) => a.id.localeCompare(b.id))) {
      const subject = o.subjectId === "" ? null : o.subjectId;
      if (!inScope(subject) && !(subject === null && task !== "suggest_explanations_for_pattern")) continue;
      if (selection.observationIds && !selection.observationIds.includes(o.id)) continue;
      if (task === "suggest_explanations_for_pattern" && !selection.observationIds?.includes(o.id)) continue; // only the selected ones
      const ref: ContextRef = { kind: "observation", id: o.id };
      push({ ref, id: refId(ref), kind: "observation", subjectId: subject, payload: { statement: o.statement, when: o.dateOrPeriod || null, sourceType: o.sourceType, storedConfidence: { note: STORED_JUDGMENT_NOTE, value: o.confidence }, subject: subjectLabel(subject), links: o.links } }, { ownKind: "observation", variableIds: o.links.variableIds, relationshipIds: o.links.relationshipIds }, `Observation ${o.id} withheld because it links to sensitive material.`);
    }
  }
  if (allows("event")) {
    for (const e of [...model.events].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!inScope(e.subjectId)) continue;
      if (selection.eventIds && !selection.eventIds.includes(e.id)) continue;
      if (task === "suggest_explanations_for_pattern" && !selection.eventIds?.includes(e.id)) continue;
      const ref: ContextRef = { kind: "event", id: e.id };
      const iv = temporalInterval(e.occurred);
      push({ ref, id: refId(ref), kind: "event", subjectId: e.subjectId, payload: { title: e.title, kind: e.kind, type: e.type, occurred: { text: e.occurred.text || null, start: iv?.start ?? null, end: iv?.end ?? null, precision: e.occurred.precision, kind: e.occurred.kind }, sourceType: e.sourceType, storedConfidence: { note: STORED_JUDGMENT_NOTE, value: e.confidence }, subject: subjectLabel(e.subjectId) } }, { ownKind: "event", variableIds: e.links.variableIds, relationshipIds: e.links.relationshipIds }, `Event ${e.id} withheld because it links to sensitive material.`);
    }
  }

  // ---- relationships, constraints, hypotheses ----
  const varSubject = new Map(model.variables.map((v) => [v.id, v.subjectId]));
  if (allows("relationship")) {
    for (const r of [...model.relationships].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!inScope(varSubject.get(r.sourceVariableId) ?? null) || !inScope(varSubject.get(r.targetVariableId) ?? null)) continue;
      const ref: ContextRef = { kind: "relationship", id: r.id };
      push({ ref, id: refId(ref), kind: "relationship", subjectId: null, payload: { from: refId({ kind: "variable", id: r.sourceVariableId }), to: refId({ kind: "variable", id: r.targetVariableId }), direction: r.direction, kind: r.kind, enabled: r.enabled, participatesInDynamics: r.participatesInDynamics, storedJudgments: { note: STORED_JUDGMENT_NOTE, strength: r.strength, lag: r.lag, confidence: r.confidence }, sourceType: r.sourceType } }, { ownKind: "relationship", variableIds: [r.sourceVariableId, r.targetVariableId] }, `Relationship ${r.id} withheld because it names a sensitive variable.`);
    }
  }
  if (allows("constraint")) {
    for (const c of [...model.constraints].sort((a, b) => a.id.localeCompare(b.id))) {
      const subject = c.subjectId === undefined || c.subjectId === "" ? null : c.subjectId;
      if (subject !== null && !inScope(subject)) continue;
      const ref: ContextRef = { kind: "constraint", id: c.id };
      push({ ref, id: refId(ref), kind: "constraint", subjectId: subject, payload: { name: c.name, type: c.type, check: c.check ?? null, softPenalty: c.softPenalty, sourceType: c.sourceType, storedConfidence: { note: STORED_JUDGMENT_NOTE, value: c.confidence } } }, { ownKind: "constraint" });
    }
  }
  if (allows("hypothesis")) {
    for (const h of [...model.hypotheses].sort((a, b) => a.id.localeCompare(b.id))) {
      if (h.subjectId !== null && !inScope(h.subjectId)) continue;
      if (task === "suggest_questions_to_reduce_uncertainty" && h.confidence !== null && h.disconfirmingConditions.length > 0) continue;
      const ref: ContextRef = { kind: "hypothesis", id: h.id };
      push({ ref, id: refId(ref), kind: "hypothesis", subjectId: h.subjectId, payload: { statement: h.statement, status: h.status, confidence: h.confidence === null ? "not assessed" : { note: STORED_JUDGMENT_NOTE, value: h.confidence }, disconfirmingConditions: h.disconfirmingConditions, relationshipIds: h.relationshipIds, subject: subjectLabel(h.subjectId) } }, { ownKind: "hypothesis", relationshipIds: h.relationshipIds, variableIds: [...h.predictions.map((x) => x.variableId), ...h.killCriteria.map((k) => k.variableId)].filter((x): x is string => typeof x === "string"), observationIds: [...h.supportingObservationIds, ...h.contradictingObservationIds] }, `Hypothesis ${h.id} withheld because it references sensitive material.`);
    }
  }

  // ---- pattern + Explore comparison (deterministic engine output as input) ----
  if (selection.pattern && (allows("pattern") || allows("cross_context"))) {
    const p = selection.pattern;
    const y = model.variables.find((v) => v.id === p.variableId);
    if (allows("pattern")) {
      const history = y && y.kind === "input" ? describeVariableHistory(y, p.interval) : null;
      const ref: ContextRef = { kind: "pattern", pattern: p };
      push({ ref, id: refId(ref), kind: "pattern", subjectId: p.subjectId, payload: { variable: y?.name ?? p.variableId, unit: y?.unit ?? "", repeatedValue: p.repeatedValue, occurrenceTimes: p.occurrenceTimes, interval: p.interval, historyFacts: history ? { applicationTimes: history.applicationTimes, repeatedValues: history.repeatedValues, facts: history.facts, caveats: history.caveats.map((c) => c.code) } : null } }, { ownKind: "pattern", variableIds: [p.variableId] }, "Pattern withheld because its variable is sensitive.");
    }
    if (allows("cross_context")) {
      const r = crossContext(model, p, { contextSubjectIds: contextSubjectsFor(model, p, domain) });
      const ref: ContextRef = { kind: "cross_context", pattern: p };
      // every constituent the comparison embeds: the pattern variable, every context condition, every nearby event
      const embedded: Constituents = r.ok
        ? { ownKind: "cross_context", variableIds: [p.variableId, ...r.conditions.map((c) => c.variableId), ...[...r.occurrences, ...r.contrasts].flatMap((sl) => sl.context.map((c) => c.variableId))], eventIds: [...r.occurrences, ...r.contrasts].flatMap((sl) => sl.eventsNear.map((e) => e.id)) }
        : { ownKind: "cross_context", variableIds: [p.variableId] };
      push({ ref, id: refId(ref), kind: "cross_context", subjectId: p.subjectId, payload: r.ok ? { note: "deterministic Explore comparison; classifications are the engine's, never to be recomputed", result: stripForContext(r) } : { unresolved: r.reason, message: r.message } }, embedded, "Explore comparison withheld because it contains sensitive context; it is never sent trimmed.");
    }
    if (allows("catalogue_prompt") && domain?.explanationCatalogue) {
      for (const q of domain.explanationCatalogue.prompts) {
        const ref: ContextRef = { kind: "catalogue_prompt", domainId: domain.id, domainVersion: domain.version, promptId: q.id };
        push({ ref, id: refId(ref), kind: "catalogue_prompt", subjectId: null, payload: { question: q.question, locus: q.locus, hint: q.hint ?? null } }, { ownKind: "catalogue_prompt" });
      }
    }
  }

  // ---- the person's text ----
  if (allows("user_text") && selection.userText?.trim()) {
    const text = selection.userText;
    const ref: ContextRef = { kind: "user_text", textHash: contentHash(text) };
    push({ ref, id: refId(ref), kind: "user_text", subjectId: selection.subjectId ?? model.id, payload: { text, aboutSubject: subjectLabel(selection.subjectId ?? model.id), sourceType: "self_reported" } }, { ownKind: "user_text" });
  }

  // ---- manifest ----
  const included: AiContextManifest["included"] = {};
  for (const it of items) included[it.kind] = (included[it.kind] ?? 0) + 1;
  const allSubjects = [model.id, ...model.profile.members.map((m) => m.id)];
  const subjectsExcluded = allSubjects.filter((id) => !scopeSet.has(id)).map((id) => ({ id, reason: scopeReason }));
  const exclusions = [
    "notes fields of every record are excluded",
    "evidence free text is excluded",
    "superseded and retracted history entries are excluded",
    "the proposal ledger is not included",
    "browser drafts are not included",
    ...policy.kinds.length < 14 ? [`item kinds outside this task's allowlist are excluded (allowed: ${policy.kinds.join(", ")})`] : [],
  ];
  const payload = providerPayload({ task, items });
  const manifest: AiContextManifest = { task, included, subjectsIncluded: scope, subjectsExcluded, exclusions, sensitiveExcluded, withheld, approxChars: canonical(payload).length };
  return { task, systemId: model.id, items, manifest, sourceRevisionHash: sourceRevisionHashOf(model), contextHash: contextHashOf(payload), builtAt: options.now ?? new Date().toISOString() };
}

/** The Explore result minus nothing semantic: entry ids and readings stay; the
 *  free-text `statements` are the engine's own sentences and stay too. */
function stripForContext(r: CrossContext): Record<string, unknown> {
  return { pattern: r.pattern, variableName: r.variableName, unit: r.unit, window: r.window, occurrences: r.occurrences, contrasts: r.contrasts, contrastNote: r.contrastNote, conditions: r.conditions, groups: r.groups, statements: r.statements, caveats: r.caveats.map((c) => c.code) };
}

/** Exactly what a provider would receive, canonical text (the hashed content). */
export function hashedContent(ctx: AiContext): string {
  return canonical(providerPayload(ctx));
}

export function domainOf(model: SystemModel): DomainDefinition | undefined {
  return domainRegistry.get(model.domainDefinitionId, model.domainDefinitionVersion);
}
