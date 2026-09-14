/**
 * evaluateSystem: the ONE function the UI (and the scenario engine) call to
 * turn a stored SystemModel into everything derived from it — recomputed
 * variables, structural gaps, feedback loops with pressure, leverage
 * rankings, feasibility of actions. It is pure and synchronous.
 */
import {
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
import type { Action, LoopAnnotation, Relationship, SystemModel, Variable } from "@/types";
import { computeDerivedVariables, type DerivedComputation } from "./derived";

export interface EvaluatedLoop extends FeedbackLoop {
  annotation?: LoopAnnotation;
  /** A10; null when no loop variable has a desired value. */
  pressure: number | null;
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

export interface ModelIssue {
  level: "error" | "warning";
  message: string;
}

export interface EvaluatedSystem {
  model: SystemModel;
  /** Inputs untouched + derived recomputed. */
  variables: Variable[];
  variableById: Map<string, Variable>;
  derived: DerivedComputation[];
  gap: GapSummary;
  normalizedGapById: Map<string, number>;
  loops: EvaluatedLoop[];
  /** Relationships whose endpoints both exist. */
  relationships: Relationship[];
  networkInfluence: Map<string, number>;
  variableLeverage: VariableLeverage[];
  /** Variables with no `impact` judgment (leverage not computed). */
  unassessedVariables: Variable[];
  actions: EvaluatedAction[];
  issues: ModelIssue[];
}

export function evaluateSystem(model: SystemModel): EvaluatedSystem {
  const issues: ModelIssue[] = [];
  const { variables, computations } = computeDerivedVariables(model.variables, model.incomeSources);
  const variableById = new Map(variables.map((v) => [v.id, v]));

  const relationships = model.relationships.filter((r) => {
    const ok = variableById.has(r.sourceVariable) && variableById.has(r.targetVariable);
    if (!ok) {
      issues.push({
        level: "error",
        message: `Relationship ${r.id} references a missing variable (${r.sourceVariable} -> ${r.targetVariable}) and was ignored.`,
      });
    }
    return ok;
  });

  const gap = structuralGap(variables);
  const normalizedGapById = new Map(gap.gaps.map((g) => [g.variableId, g.normalizedGap]));

  const loops: EvaluatedLoop[] = findFeedbackLoops(relationships).map((loop) => ({
    ...loop,
    annotation: model.loopAnnotations[loop.id],
    pressure: loopPressure(loop, normalizedGapById),
  }));

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
    variables,
    variableById,
    derived: computations,
    gap,
    normalizedGapById,
    loops,
    relationships,
    networkInfluence: influence,
    variableLeverage,
    unassessedVariables,
    actions: evaluatedActions,
    issues,
  };
}
