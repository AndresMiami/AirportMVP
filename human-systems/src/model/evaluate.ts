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
import { domainRegistry, unassignedVariables, type DomainDefinition } from "./domain";

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
  level: "error" | "warning";
  message: string;
}

export interface EvaluatedSystem {
  model: SystemModel;
  /** The domain definition the system was evaluated under. */
  domain: DomainDefinition;
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

export function evaluateSystem(model: SystemModel): EvaluatedSystem {
  const issues: ModelIssue[] = [];
  const domain = domainRegistry.require(model.domainDefinitionId, model.domainDefinitionVersion);
  const { variables, computations } = computeDerivedVariables(model.variables, model.incomeSources, domain.derived, model.id);
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
      utility: utilityView(action.utility, model.utilityWeights),
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
