/**
 * DOMAIN INTERFACE — owned by the engine.
 *
 * A domain definition tells the generic engine which variables, derived
 * formulas, projections, signature dimensions, constraint templates and
 * event types are relevant to a kind of problem. The engine never imports
 * a concrete domain; a domain registers itself here (see src/domains).
 *
 *   CORE ENGINE  <-  this interface  <-  src/domains/<domain> configuration
 */
import type { SignatureDefinition } from "@/types/signature";
import {
  GENERIC_CATEGORIES,
  type ChangeSpeed,
  type CollectionItem,
  type Constraint,
  type SubjectId,
  type SystemType,
  type TargetMode,
  type Variable,
  type VariableCategory,
} from "@/types";
import type { ModelAssumption } from "@/domain/assumptions";
import type { ZodType } from "zod";

export type SubjectScope = "system" | "member";

export interface VariableDefinition {
  key: string;
  name: string;
  description: string;
  unit: string;
  category: VariableCategory;
  changeSpeed: ChangeSpeed;
  /** system: one per system; member: one per subject. */
  scope: SubjectScope;
  targetMode: TargetMode;
  referenceRange?: { min: number; max: number };
  /** The question to ask when the value is missing. */
  question?: string;
}

/** Where a derived formula's input comes from: the whole system, or the
 *  SAME subject the formula is being computed for (the system itself for a
 *  system-scope definition, one member for a member-scope definition). */
export type DerivedInputSource = "system" | "subject";

export interface DerivedInputRef {
  key: string;
  from: DerivedInputSource;
}

/** Values visible to a derived formula. Only DECLARED inputs resolve; an
 *  undeclared key or collection is a definition bug and throws. */
export interface DerivedContext {
  /** The subject this evaluation is for (system id or member id). */
  subjectId: SubjectId;
  value: (key: string) => number | null;
  derived: (key: string) => number | null;
  /** Items of a collection the definition declared in `collectionsRead`
   *  (typed by the domain that owns it). Empty when nothing is recorded. */
  collection: <T extends CollectionItem = CollectionItem>(name: string) => readonly T[];
  /** Minimum of the items' declared confidence field; null when the
   *  collection is empty or declares no confidence field (never fabricated). */
  collectionConfidence: (name: string) => number | null;
}

/** A collection a domain pack owns. The engine stores the envelope; the
 *  pack owns the meaning. */
export interface CollectionDefinition {
  name: string;
  label: string;
  description?: string;
  /** Item schema; must accept { id: string } plus the pack's fields. */
  itemSchema: ZodType<CollectionItem>;
  /** Item fields that hold a subject id (member id or null), so the engine
   *  can check them and count references without knowing their meaning. */
  subjectFields: string[];
  /** Item field holding a 0..1 confidence, if the pack records one. */
  confidenceField?: string;
  /** Item field holding the item's provenance (a SourceType), if the pack
   *  records one. The generic layer counts provenance ONLY through this
   *  declaration, never by finding a field that happens to be so named. */
  provenanceField?: string;
  /** Optional screen route for the collection (the nav lists it under
   *  `label` when the active domain declares the collection). */
  route?: string;
  /** Presentation metadata (optional): how the generic screens present
   *  this collection. The engine never reads it. */
  onboarding?: {
    /** Getting-started step title ("Add income sources"). */
    title: string;
    /** One-line explanation for the step. */
    detail: string;
  };
  /** Numeric item fields a scenario may set directly (the generic scenario
   *  screen offers one field per item; the change is updateCollectionItem). */
  scenarioFields?: { field: string; label: string; min?: number }[];
}

/** A scenario preset a domain offers: KEYS with explicit scope, never
 *  variable ids; each key is resolved for the chosen subject at click time. */
export interface ScenarioPreset {
  name: string;
  description: string;
  deltas: { key: string; scope: SubjectScope; delta: number }[];
}

/** Presentation configuration a domain may supply for the generic
 *  screens. Configuration only: the engine never reads it, and nothing in
 *  it changes a calculation. */
export interface DomainPresentation {
  /** Variables the dashboard shows first (system keys once, member keys per
   *  active subject). Absent keys are skipped. */
  headlineKeys?: { key: string; scope: SubjectScope }[];
  scenarioPresets?: ScenarioPreset[];
}

export interface DerivedDefinition {
  key: string;
  name: string;
  description: string;
  unit: string;
  category: VariableCategory;
  changeSpeed: ChangeSpeed;
  targetMode: TargetMode;
  /** system: computed once, subject = the system. member: computed
   *  independently for each member, subject = that member. Members are
   *  never averaged into a system value by the engine. */
  scope: SubjectScope;
  /** Input variables the formula reads, each with its source. */
  inputs: DerivedInputRef[];
  /** Earlier derived definitions the formula reads, each with its source. */
  derivedInputs: DerivedInputRef[];
  /** Collections the formula reads (must be declared by the domain). */
  collectionsRead: string[];
  assumptionIds: string[];
  compute: (ctx: DerivedContext) => number | null;
  defaultReferenceRange?: { min: number; max: number };
}

export interface ProjectionInput {
  key: string;
  scope: SubjectScope;
}

/** A step-model trajectory the scenario screen may draw, labelled a model
 *  assumption. scope "member" means one trajectory per member for whom
 *  every member-scope input resolves. */
export interface ProjectionDefinition {
  id: string;
  label: string;
  unit: string;
  assumptionIds: string[];
  scope: SubjectScope;
  inputs: ProjectionInput[];
  compute: (values: ReadonlyMap<string, number>, months: number) => number[];
}

export interface ConstraintTemplate {
  id: string;
  /** Short button label. */
  label: string;
  name: string;
  description: string;
  type: Constraint["type"];
  /** limit null = the person supplies the number after prefill. */
  check?: { dimension: string; comparator: "lte" | "gte" | "eq"; limit: number | boolean | null };
  softPenalty?: number;
}

/** A named option-evaluation dimension. The engine reads only the key
 *  and the direction; the meaning is the domain's. */
export interface EvaluationDimension {
  key: string;
  label: string;
  higherIsBetter: boolean;
}

export interface CategoryDefinition {
  id: string;
  label: string;
  description: string;
}

/** Domain vocabulary for the AI layer. The generic constitution is fixed
 *  in src/ai/prompt.ts; this fragment adds words, examples and questions. */
export interface PromptFragment {
  /** One paragraph naming the kind of system and its usual vocabulary. */
  vocabulary: string;
  /** Optional worked examples or wording guidance. */
  examples?: string;
  /** Questions that usually reduce uncertainty in this domain. */
  questions?: string[];
  /** Optional example analysis a mock provider may return for demos. */
  exampleAnalysis?: unknown;
}

export interface DomainDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  /** SUGGESTED kinds of system for a picker; the engine never interprets
   *  them, any label is allowed, and a kind never implies a domain (the
   *  domain is chosen explicitly and stored as domainDefinitionId). */
  kinds: { id: SystemType; label: string }[];
  /** What the domain calls a subject ("Person", "Segment", "Unit"). */
  subjectLabel: string;
  /** Plural of subjectLabel ("People"); defaults to subjectLabel + "s". */
  subjectLabelPlural?: string;
  /** Categories added to the generic vocabulary. */
  categories?: CategoryDefinition[];
  variables: VariableDefinition[];
  derived: DerivedDefinition[];
  projections: ProjectionDefinition[];
  signatureDefinition: SignatureDefinition;
  constraintTemplates: ConstraintTemplate[];
  eventTypes: string[];
  /** Collections this domain owns (may be empty). */
  collections?: CollectionDefinition[];
  /** Option-evaluation dimensions this domain declares (may be empty). */
  evaluationDimensions?: EvaluationDimension[];
  /** The domain's own model assumptions (ids unique across the registry). */
  assumptions?: ModelAssumption[];
  promptFragment?: PromptFragment;
  /** Optional presentation configuration for the generic screens. */
  presentation?: DomainPresentation;
}

/** The plural word for subjects in this domain. */
export function subjectLabelPluralOf(domain: Pick<DomainDefinition, "subjectLabel" | "subjectLabelPlural">): string {
  return domain.subjectLabelPlural ?? `${domain.subjectLabel}s`;
}

/** The category words a domain accepts: generic plus its own. */
export function categoryVocabulary(domain?: Pick<DomainDefinition, "categories">): VariableCategory[] {
  return [...GENERIC_CATEGORIES, ...(domain?.categories?.map((c) => c.id) ?? [])];
}

/** Declared evaluation-dimension keys (empty = the domain declares none). */
export function evaluationDimensionKeys(domain?: Pick<DomainDefinition, "evaluationDimensions">): string[] {
  return domain?.evaluationDimensions?.map((d) => d.key) ?? [];
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

class DomainRegistry {
  private readonly defs = new Map<string, DomainDefinition>();

  private keyOf(id: string, version: number): string {
    return `${id}@${version}`;
  }

  /** Idempotent: re-registering the same id@version replaces it. */
  register(def: DomainDefinition): void {
    this.defs.set(this.keyOf(def.id, def.version), def);
  }

  get(id: string, version?: number): DomainDefinition | undefined {
    if (version !== undefined) return this.defs.get(this.keyOf(id, version));
    const versions = [...this.defs.values()].filter((d) => d.id === id).sort((a, b) => b.version - a.version);
    return versions[0];
  }

  require(id: string, version?: number): DomainDefinition {
    const def = this.get(id, version);
    if (!def) {
      throw new Error(
        `Domain definition "${id}"${version !== undefined ? ` version ${version}` : ""} is not registered; register it before evaluating a system that uses it`,
      );
    }
    return def;
  }

  list(): DomainDefinition[] {
    return [...this.defs.values()];
  }

  /** Test support only. */
  clear(): void {
    this.defs.clear();
  }
}

export const domainRegistry = new DomainRegistry();

/* ------------------------------------------------------------------ */
/* Variable references                                                 */
/* ------------------------------------------------------------------ */

/**
 * A reference to a variable by definition key and EXPLICIT scope. There is
 * no null here: `Variable.subjectId === null` means UNASSIGNED in storage,
 * and an unassigned variable has no resolvable reference at all.
 */
export type VariableRef =
  | { key: string; scope: "system" }
  | { key: string; scope: "subject"; subjectId: SubjectId };

export function systemRef(key: string): VariableRef {
  return { key, scope: "system" };
}

export function subjectRef(key: string, subjectId: SubjectId): VariableRef {
  return { key, scope: "subject", subjectId };
}

/** Reference for a KNOWN subject id: the system's own id is a system
 *  reference, any other id a subject reference. Never accepts null. */
export function refFor(key: string, subjectId: SubjectId, systemId: string): VariableRef {
  return subjectId === systemId ? systemRef(key) : subjectRef(key, subjectId);
}

/**
 * Resolve a reference among a system's variables. A system reference
 * matches only a variable attributed to the system; a subject reference
 * only that subject's variable. An UNASSIGNED variable (subjectId null)
 * is never matched: nobody has said whose it is, so it feeds no
 * computation until assigned.
 */
export function resolveVariable<V extends Pick<Variable, "key" | "subjectId">>(variables: readonly V[], systemId: string, ref: VariableRef): V | undefined {
  const subject = ref.scope === "system" ? systemId : ref.subjectId;
  // Runtime guard behind the type: a non-string subject (null smuggled in
  // from untyped data) must never match the unassigned rows.
  if (typeof subject !== "string" || subject.length === 0) return undefined;
  return variables.find((v) => v.key === ref.key && v.subjectId === subject);
}

/** Canonical id for a NEW variable created from a definition key. */
export function variableIdFor(key: string, subjectId: SubjectId | null, systemId: string): string {
  if (subjectId === null || subjectId === systemId) return key;
  return `${key}@${subjectId}`;
}

export function variableDefinitionFor(domain: DomainDefinition, key: string): VariableDefinition | undefined {
  return domain.variables.find((v) => v.key === key);
}

export function derivedDefinitionFor(domain: DomainDefinition, key: string): DerivedDefinition | undefined {
  return domain.derived.find((d) => d.key === key);
}

/** Variables whose subject has not been assigned. */
export function unassignedVariables<V extends Pick<Variable, "subjectId">>(variables: readonly V[]): V[] {
  return variables.filter((v) => v.subjectId === null);
}

/** The declared collection definition, or undefined when the domain does
 *  not declare it (an undeclared collection is opaque to the engine). */
export function collectionDefinitionFor(domain: Pick<DomainDefinition, "collections"> | undefined, name: string): CollectionDefinition | undefined {
  return domain?.collections?.find((c) => c.name === name);
}
