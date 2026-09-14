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

/** Values visible to a derived formula, resolved at SYSTEM scope. */
export interface DerivedContext {
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
  /** Input variable keys (system scope). */
  inputKeys: string[];
  /** Derived keys read (must appear earlier in the domain's list). */
  inputDerivedKeys: string[];
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

/** A key resolved for a subject. subjectId null = system scope. */
export interface VariableRef {
  key: string;
  subjectId: SubjectId | null;
}

/**
 * Resolve a reference among a system's variables. An UNASSIGNED variable
 * (subjectId null) is never matched: nobody has said whose it is, so it
 * feeds no computation until assigned.
 */
export function resolveVariable(
  variables: readonly Variable[],
  systemId: string,
  ref: VariableRef,
): Variable | undefined {
  const subject = ref.subjectId ?? systemId;
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
