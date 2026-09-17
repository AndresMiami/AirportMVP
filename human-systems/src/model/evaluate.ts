/**
 * evaluateSystem: the ONE function the UI (and the scenario engine) call to
 * turn a stored SystemModel into everything derived from it — recomputed
 * variables, structural gaps, feedback loops with pressure, leverage
 * rankings, feasibility of actions. It is pure and synchronous.
 */
import {
  activeRelationships,
  checkFeasibility,
  findFeedbackLoops,
  leverageScore,
  loopPressure,
  networkInfluence,
  rankByLeverage,
  structuralGap,
  utilityView,
  type FeasibilityResult,
  type FeedbackLoop,
  type GapSummary,
  type LeverageResult,
  type UtilityView,
} from "@/calculations";
import type {
  Action,
  Hypothesis,
  HypothesisStatus,
  LoopAnnotation,
  Observation,
  Relationship,
  SystemModel,
  Variable,
} from "@/types";
import { computeDerivedVariables, type DerivedComputation } from "./derived";
import { categoryVocabulary, domainRegistry, evaluationDimensionKeys, unassignedVariables, type DomainDefinition } from "./domain";
import { describeResolution, normalizeInstant, resolveVariableAt } from "./history";

export interface EvaluateOptions {
  /** The clock: "current" means the latest entry applying at this instant.
   *  Defaults to the real clock. */
  now?: string;
  /** Reconstruct VALUES and TARGETS as they applied at this instant (ISO
   *  instant, or a date meaning the end of that day). The structural graph
   *  (relationships, constraints, hypotheses, domain definition) is NOT
   *  versioned and stays as it is now; stored snapshots remain the
   *  authoritative record of a past complete model. */
  asOf?: string;
  /** Compute member-scope derived values for archived members too (their
   *  shells and histories are always kept; computation is opt-in). */
  includeArchivedMembers?: boolean;
}

export interface EvaluationClock {
  now: string;
  /** null when evaluating the present. */
  asOf: string | null;
  /** The instant values and targets were resolved at. */
  valuesAsOf: string;
  /** Always "current": the graph is not reconstructed. */
  structureAsOf: "current";
}

export interface EvaluatedLoop extends FeedbackLoop {
  annotation?: LoopAnnotation;
  /** A10; null when no loop variable has a desired value. */
  pressure: number | null;
  /** The hypothesis recorded for this loop, if any (A18). */
  hypothesis?: Hypothesis;
  /** Epistemic status: the hypothesis status, or "proposed" when none is
   *  recorded. A detected loop is never more than its hypothesis says. */
  status: HypothesisStatus;
  /** Observations linked to this loop's hypothesis or to any of its edges. */
  observationIds: string[];
}

export interface VariableLeverage {
  variable: Variable;
  leverage: LeverageResult;
  rank: number;
}

export interface EvaluatedAction {
  action: Action;
  feasibility: FeasibilityResult;
  leverage: LeverageResult;
  utility: UtilityView;
  /** Rank among FEASIBLE actions only; null when infeasible. */
  rank: number | null;
}

/** Observations indexed by the entity they are linked to. */
export interface ObservationIndex {
  byVariable: Map<string, Observation[]>;
  byRelationship: Map<string, Observation[]>;
  byConstraint: Map<string, Observation[]>;
  byHypothesis: Map<string, Observation[]>;
}

export interface ModelIssue {
  level: "error" | "warning" | "info";
  message: string;
}

export interface EvaluatedSystem {
  model: SystemModel;
  /** The domain definition the system was evaluated under. */
  domain: DomainDefinition;
  clock: EvaluationClock;
  /** Inputs untouched + derived recomputed. */
  variables: Variable[];
  variableById: Map<string, Variable>;
  derived: DerivedComputation[];
  gap: GapSummary;
  normalizedGapById: Map<string, number>;
  loops: EvaluatedLoop[];
  /** ENABLED relationships whose endpoints both exist (used by loops,
   *  propagation and influence). */
  relationships: Relationship[];
  /** Every stored relationship with existing endpoints, disabled included. */
  allRelationships: Relationship[];
  disabledRelationshipCount: number;
  /** Edges stored but not taking part in dynamics (unclassified, association,
   *  constraint, or definitional not opted in). */
  nonDynamicsRelationshipCount: number;
  unclassifiedRelationshipCount: number;
  /** Variables whose subject has not been assigned. */
  unassignedVariables: Variable[];
  observations: ObservationIndex;
  networkInfluence: Map<string, number>;
  variableLeverage: VariableLeverage[];
  /** Variables with no `impact` judgment (leverage not computed). */
  unassessedVariables: Variable[];
  actions: EvaluatedAction[];
  issues: ModelIssue[];
}

export function evaluateSystem(model: SystemModel, options: EvaluateOptions = {}): EvaluatedSystem {
  const issues: ModelIssue[] = [];
  const domain = domainRegistry.require(model.domainDefinitionId, model.domainDefinitionVersion);
  const now = options.now ?? new Date().toISOString();
  const asOf = options.asOf ? normalizeInstant(options.asOf) : null;
  const valuesAsOf = asOf ?? now;
  const clock: EvaluationClock = { now, asOf, valuesAsOf, structureAsOf: "current" };
  const memberIds = model.profile.members.filter((m) => options.includeArchivedMembers || m.status === "active").map((m) => m.id);
  const inputs = model.variables.filter((v) => v.kind === "input").map((v) => resolveVariableAt(v, valuesAsOf));
  const shells = model.variables.filter((v) => v.kind === "derived");
  // Domain validation of DECLARED collections: schema-valid storage is not
  // domain-valid data. A collection with an item the pack's schema refuses
  // is reported and withheld from every calculation (unknown, never a
  // guessed number); the record itself stays intact for correction.
  const usable: SystemModel["collections"] = {};
  for (const [name, envelope] of Object.entries(model.collections)) {
    const def = (domain.collections ?? []).find((c) => c.name === name);
    if (!def || envelope.origin !== "domain") {
      usable[name] = envelope;
      continue;
    }
    const invalid = envelope.items.filter((item) => !def.itemSchema.safeParse(item).success);
    if (invalid.length === 0) {
      usable[name] = envelope;
      continue;
    }
    issues.push({
      level: "warning",
      message: `${def.label}: ${invalid.length} record${invalid.length > 1 ? "s" : ""} (${invalid.map((i) => `"${i.id}"`).join(", ")}) do${invalid.length > 1 ? "" : "es"} not match this domain's definition; the collection is withheld from calculations until corrected.`,
    });
  }
  const access = {
    declared: new Map((domain.collections ?? []).map((c) => [c.name, { confidenceField: c.confidenceField }])),
    collections: usable,
  };
  const { variables, computations } = computeDerivedVariables(inputs, shells, access, domain.derived, model.id, memberIds, valuesAsOf);
  // Opaque collections: preserved data this domain does not declare. Never
  // evaluated, never claimed valid or invalid; the person can see it exists.
  for (const [name, envelope] of Object.entries(model.collections)) {
    if (access.declared.has(name) && envelope.origin === "domain") continue;
    if (envelope.items.length === 0) continue;
    issues.push({
      level: "info",
      message: `Collection "${name}" holds ${envelope.items.length} preserved record${envelope.items.length > 1 ? "s" : ""} this domain does not declare${envelope.origin === "legacy_universal" ? " (kept from an older format)" : ""}; not used in any calculation.`,
    });
  }
  if (asOf) {
    issues.push({
      level: "info",
      message: `Values and targets as of ${asOf.slice(0, 10)}; relationships, constraints, hypotheses, domain collections and the domain definition are today's. A stored snapshot is the record of the whole model at a past date.`,
    });
  }
  // Historical vocabulary outside the active domain is kept, never
  // reinterpreted; it is reported so the person can see it.
  const vocabulary = new Set<string>(categoryVocabulary(domain));
  const foreignCategories = model.variables.filter((v) => !vocabulary.has(v.category));
  if (foreignCategories.length > 0) {
    issues.push({
      level: "info",
      message: `${foreignCategories.length} variable${foreignCategories.length > 1 ? "s use" : " uses"} a category this domain does not declare (${[...new Set(foreignCategories.map((v) => v.category))].join(", ")}); kept as recorded.`,
    });
  }
  const declaredDims = new Set(evaluationDimensionKeys(domain));
  const foreignDims = new Set(model.actions.flatMap((a) => Object.keys(a.utility).filter((k) => !declaredDims.has(k))));
  if (foreignDims.size > 0) {
    issues.push({ level: "info", message: `Actions carry evaluation dimensions this domain does not declare (${[...foreignDims].sort().join(", ")}); shown as recorded.` });
  }
  const ambiguous = inputs.filter((v) => v.valueResolution === "ambiguous" || v.targetResolution === "ambiguous");
  for (const v of ambiguous) {
    const which = v.valueResolution === "ambiguous" ? "value" : "target";
    issues.push({ level: "warning", message: `${v.name}: ${describeResolution("ambiguous")} (${which} history).` });
  }
  const unorderableOnly = inputs.filter((v) => v.valueResolution === "unorderable_only");
  if (unorderableOnly.length > 0) {
    issues.push({
      level: "warning",
      message: `${unorderableOnly.map((v) => v.name).slice(0, 4).join(", ")}${unorderableOnly.length > 4 ? ", …" : ""}: recorded values have no orderable time, so they stay unknown for calculation until a time is given.`,
    });
  }
  const variableById = new Map(variables.map((v) => [v.id, v]));
  const unassigned = unassignedVariables(variables);
  if (unassigned.length > 0) {
    issues.push({
      level: "warning",
      message: `${unassigned.length} variable${unassigned.length > 1 ? "s have" : " has"} no subject assigned (${unassigned.map((v) => v.name).slice(0, 4).join(", ")}${unassigned.length > 4 ? ", …" : ""}); they feed no calculation until assigned.`,
    });
  }

  const allRelationships = model.relationships.filter((r) => {
    const ok = variableById.has(r.sourceVariableId) && variableById.has(r.targetVariableId);
    if (!ok) {
      issues.push({
        level: "error",
        message: `Relationship ${r.id} references a missing variable (${r.sourceVariableId} -> ${r.targetVariableId}) and was ignored.`,
      });
    }
    return ok;
  });
  const relationships = activeRelationships(allRelationships);
  const disabledRelationshipCount = allRelationships.filter((r) => !r.enabled).length;
  const nonDynamicsRelationshipCount = allRelationships.filter((r) => r.enabled && !r.participatesInDynamics).length;
  const unclassifiedRelationshipCount = allRelationships.filter((r) => r.kind === "unclassified").length;
  if (unclassifiedRelationshipCount > 0) {
    issues.push({
      level: "warning",
      message: `${unclassifiedRelationshipCount} relationship${unclassifiedRelationshipCount > 1 ? "s are" : " is"} unclassified and excluded from loops until reviewed.`,
    });
  }

  const gap = structuralGap(variables);
  const normalizedGapById = new Map(gap.gaps.map((g) => [g.variableId, g.normalizedGap]));

  const observations = indexObservations(model.observations);
  const loopHypotheses = new Map(
    model.hypotheses.filter((h) => h.kind === "loop" && h.loopId).map((h) => [h.loopId!, h]),
  );

  const loops: EvaluatedLoop[] = findFeedbackLoops(relationships).map((loop) => {
    const hypothesis = loopHypotheses.get(loop.id);
    const linked = new Set<string>();
    if (hypothesis) {
      for (const o of observations.byHypothesis.get(hypothesis.id) ?? []) linked.add(o.id);
      for (const id of [...hypothesis.supportingObservationIds, ...hypothesis.contradictingObservationIds]) linked.add(id);
    }
    for (const edgeId of loop.edgeIds) for (const o of observations.byRelationship.get(edgeId) ?? []) linked.add(o.id);
    return {
      ...loop,
      annotation: model.loopAnnotations[loop.id],
      pressure: loopPressure(loop, normalizedGapById),
      hypothesis,
      status: hypothesis?.status ?? "proposed",
      observationIds: [...linked],
    };
  });
  for (const h of model.hypotheses) {
    if (h.kind === "loop" && h.loopId && !loops.some((l) => l.id === h.loopId)) {
      issues.push({
        level: "warning",
        message: `Hypothesis "${h.statement.slice(0, 60)}" refers to loop ${h.loopId}, which the current (enabled) relationships no longer form.`,
      });
    }
  }

  const influence = networkInfluence(relationships);

  const assessed = variables.filter((v) => v.impact !== undefined);
  const unassessedVariables = variables.filter((v) => v.impact === undefined);
  const variableLeverage = rankByLeverage(assessed, (v) => ({
    impact: v.impact ?? 0,
    controllability: v.controllability,
    durability: v.durability,
    cost: v.estimatedCostToChange,
    uncertainty: v.effectUncertainty ?? 1 - v.confidence,
  })).map((r) => ({ variable: r.item, leverage: r.leverage, rank: r.rank }));

  const evaluatedActions: EvaluatedAction[] = model.actions.map((action) => {
    for (const t of action.targetVariables) {
      if (!variableById.has(t)) {
        issues.push({ level: "warning", message: `Action "${action.name}" targets unknown variable ${t}.` });
      }
    }
    return {
      action,
      feasibility: checkFeasibility(action, model.constraints),
      leverage: leverageScore({
        impact: action.impact,
        controllability: action.controllability,
        durability: action.durability,
        cost: action.cost,
        uncertainty: action.uncertainty,
      }),
      utility: utilityView(action.utility, model.utilityWeights, domain.evaluationDimensions ?? []),
      rank: null,
    };
  });
  const feasibleSorted = evaluatedActions
    .filter((a) => a.feasibility.feasible)
    .sort((a, b) => b.leverage.score - a.leverage.score);
  feasibleSorted.forEach((a, i) => {
    a.rank = i + 1;
  });

  for (const c of computations) {
    if (c.missingInputs.length > 0) {
      issues.push({
        level: "warning",
        message: `${c.definition.name} cannot be computed fully: missing ${c.missingInputs.join(", ")}.`,
      });
    }
  }

  return {
    model,
    domain,
    clock,
    variables,
    variableById,
    derived: computations,
    gap,
    normalizedGapById,
    loops,
    relationships,
    allRelationships,
    disabledRelationshipCount,
    nonDynamicsRelationshipCount,
    unclassifiedRelationshipCount,
    unassignedVariables: unassigned,
    observations,
    networkInfluence: influence,
    variableLeverage,
    unassessedVariables,
    actions: evaluatedActions,
    issues,
  };
}

function indexObservations(observations: readonly Observation[]): ObservationIndex {
  const idx: ObservationIndex = {
    byVariable: new Map(),
    byRelationship: new Map(),
    byConstraint: new Map(),
    byHypothesis: new Map(),
  };
  const push = (map: Map<string, Observation[]>, key: string, o: Observation) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(o);
  };
  for (const o of observations) {
    for (const id of o.links.variableIds) push(idx.byVariable, id, o);
    for (const id of o.links.relationshipIds) push(idx.byRelationship, id, o);
    for (const id of o.links.constraintIds) push(idx.byConstraint, id, o);
    for (const id of o.links.hypothesisIds) push(idx.byHypothesis, id, o);
  }
  return idx;
}
