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
import type {
  ChangeSpeed,
  Constraint,
  IncomeSource,
  SubjectId,
  SystemType,
  TargetMode,
  Variable,
  VariableCategory,
} from "@/types";

export type SubjectScope = "system" | "member";

export interface VariableDefinition {
  key: string;
  name: string;
  description: string;
  unit: string;
  category: VariableCategory;
  changeSpeed: ChangeSpeed;
  /** system: one per system; member: one per person. */
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
 *  undeclared key is a definition bug and throws. */
export interface DerivedContext {
  /** The subject this evaluation is for (system id or member id). */
  subjectId: SubjectId;
  value: (key: string) => number | null;
  derived: (key: string) => number | null;
  incomeSources: readonly IncomeSource[];
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
  usesIncomeSources: boolean;
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

export interface DomainDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  systemTypes: SystemType[];
  variables: VariableDefinition[];
  derived: DerivedDefinition[];
  projections: ProjectionDefinition[];
  signatureDefinition: SignatureDefinition;
  constraintTemplates: ConstraintTemplate[];
  eventTypes: string[];
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
export function resolveVariable(variables: readonly Variable[], systemId: string, ref: VariableRef): Variable | undefined {
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
export function unassignedVariables(variables: readonly Variable[]): Variable[] {
  return variables.filter((v) => v.subjectId === null);
}
