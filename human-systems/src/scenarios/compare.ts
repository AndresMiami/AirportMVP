/**
 * Structural scenario analysis: evaluate base and scenario models and
 * report what changed. This is NOT a prediction — the outputs are derived
 * values under the same model assumptions, plus directional tendencies
 * (A12) and loop-pressure deltas (A10).
 */
import {
  annualToMonthlyRate,
  projectCareerCapital,
  projectProductiveCapital,
  propagateDirectionalPressure,
  weeklyToMonthlyHours,
  type DirectionalPressure,
} from "@/calculations";
import { DERIVED_IDS, INPUT_IDS } from "@/model/ids";
import { evaluateSystem, type EvaluatedLoop, type EvaluatedSystem } from "@/model/evaluate";
import type { Scenario, SystemModel } from "@/types";
import { applyScenario, type AppliedScenario } from "./apply";

export type LoopChange = "weakens" | "strengthens" | "unchanged" | "not_assessable";

export interface LoopDelta {
  loop: EvaluatedLoop;
  basePressure: number | null;
  scenarioPressure: number | null;
  change: LoopChange;
}

export interface VariableDelta {
  variableId: string;
  name: string;
  unit: string;
  kind: "input" | "derived";
  base: number | null;
  scenario: number | null;
  delta: number | null;
  /** Normalised gap before and after (null when no desired value). */
  baseGap: number | null;
  scenarioGap: number | null;
}

export interface Projection {
  label: string;
  unit: string;
  assumptionIds: string[];
  base: number[];
  scenario: number[];
}

export interface ScenarioComparison {
  scenario: Scenario;
  applied: AppliedScenario;
  base: EvaluatedSystem;
  result: EvaluatedSystem;
  variableDeltas: VariableDelta[];
  loopDeltas: LoopDelta[];
  directional: DirectionalPressure[];
  projections: Projection[];
  meanGapBefore: number | null;
  meanGapAfter: number | null;
}

/** Relative change (vs. the larger of the two values) below this is "unchanged". */
export const LOOP_CHANGE_THRESHOLD = 0.05;

export function classifyLoopChange(before: number | null, after: number | null): LoopChange {
  if (before === null || after === null) return "not_assessable";
  const diff = after - before;
  const scale = Math.max(Math.abs(before), Math.abs(after));
  if (scale < 1e-9 || Math.abs(diff) / scale < LOOP_CHANGE_THRESHOLD) return "unchanged";
  return diff < 0 ? "weakens" : "strengthens";
}

function num(system: EvaluatedSystem, id: string): number | null {
  return system.variableById.get(id)?.currentValue ?? null;
}

function buildProjections(base: EvaluatedSystem, result: EvaluatedSystem, months: number): Projection[] {
  const out: Projection[] = [];

  const cc = (s: EvaluatedSystem) => {
    const start = num(s, INPUT_IDS.careerCapital);
    if (start === null) return null;
    return projectCareerCapital(start, months, {
      qualityOfEffort: num(s, INPUT_IDS.qualityOfEffort) ?? 0,
      protectedHoursPerMonth: weeklyToMonthlyHours(num(s, INPUT_IDS.protectedHours) ?? 0),
      persistence: num(s, INPUT_IDS.persistence) ?? 0,
      effortToCapitalRate: num(s, INPUT_IDS.effortToCapitalRate) ?? 0,
      switchingCostPerMonth:
        ((num(s, INPUT_IDS.switchingCost) ?? 0) * (num(s, INPUT_IDS.switchingFrequency) ?? 0)) / 12,
    });
  };
  const ccBase = cc(base);
  const ccResult = cc(result);
  if (ccBase && ccResult) {
    out.push({
      label: "Career capital (index)",
      unit: "index",
      assumptionIds: ["A6", "A15"],
      base: ccBase,
      scenario: ccResult,
    });
  }

  const pc = (s: EvaluatedSystem) => {
    const start = num(s, INPUT_IDS.productiveAssets);
    const income = num(s, DERIVED_IDS.totalIncome);
    if (start === null || income === null) return null;
    const expenses =
      (num(s, INPUT_IDS.essentialExpenses) ?? 0) +
      (num(s, INPUT_IDS.discretionaryExpenses) ?? 0) +
      (num(s, INPUT_IDS.monthlyDebtPayments) ?? 0);
    return projectProductiveCapital(start, months, {
      capitalConversionRate: num(s, INPUT_IDS.capitalConversionRate) ?? 0,
      monthlyIncome: income,
      monthlyExpenses: expenses,
      monthlyReturnRate: annualToMonthlyRate(num(s, INPUT_IDS.annualReturnRate) ?? 0),
    });
  };
  const pcBase = pc(base);
  const pcResult = pc(result);
  if (pcBase && pcResult) {
    out.push({
      label: "Productive assets",
      unit: "$",
      assumptionIds: ["A7"],
      base: pcBase,
      scenario: pcResult,
    });
  }
  return out;
}

export function compareScenario(baseModel: SystemModel, scenario: Scenario): ScenarioComparison {
  const base = evaluateSystem(baseModel);
  const applied = applyScenario(baseModel, scenario);
  const result = evaluateSystem(applied.model);

  const variableDeltas: VariableDelta[] = base.variables.map((v) => {
    const after = result.variableById.get(v.id);
    const b = v.currentValue;
    const s = after?.currentValue ?? null;
    return {
      variableId: v.id,
      name: v.name,
      unit: v.unit,
      kind: v.kind,
      base: b,
      scenario: s,
      delta: b === null || s === null ? null : s - b,
      baseGap: base.normalizedGapById.get(v.id) ?? null,
      scenarioGap: result.normalizedGapById.get(v.id) ?? null,
    };
  });

  const resultLoopById = new Map(result.loops.map((l) => [l.id, l]));
  const loopDeltas: LoopDelta[] = base.loops.map((loop) => {
    const after = resultLoopById.get(loop.id);
    const basePressure = loop.pressure;
    const scenarioPressure = after?.pressure ?? null;
    return { loop, basePressure, scenarioPressure, change: classifyLoopChange(basePressure, scenarioPressure) };
  });

  // Seeds for directional propagation: changed inputs plus derived values
  // that moved because of them (income-source edits move derived values only).
  const seeds = new Map<string, 1 | -1>(applied.changedVariables);
  for (const d of variableDeltas) {
    if (d.kind === "derived" && d.delta !== null && Math.abs(d.delta) > 1e-9) {
      seeds.set(d.variableId, d.delta > 0 ? 1 : -1);
    }
  }
  const directional = propagateDirectionalPressure(base.relationships, seeds);

  return {
    scenario,
    applied,
    base,
    result,
    variableDeltas,
    loopDeltas,
    directional,
    projections: buildProjections(base, result, scenario.horizonMonths),
    meanGapBefore: base.gap.meanNormalizedGap,
    meanGapAfter: result.gap.meanNormalizedGap,
  };
}
