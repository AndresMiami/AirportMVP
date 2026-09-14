/**
 * Structural scenario analysis: evaluate base and scenario models and
 * report what changed. This is NOT a prediction — the outputs are derived
 * values under the same model assumptions, plus directional tendencies
 * (A12) and loop-pressure deltas (A10).
 */
import {
  annualToMonthlyRate,
  HORIZON_ORDER,
  projectCareerCapital,
  projectProductiveCapital,
  propagateDirectionalPressure,
  weeklyToMonthlyHours,
  type DirectionalPressure,
  type Horizon,
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

/** Directional tendencies grouped by the earliest horizon they could show
 *  (A16). Groups are in horizon order and empty groups are omitted. */
export interface HorizonGroup {
  horizon: Horizon;
  tendencies: DirectionalPressure[];
}

export function groupByHorizon(tendencies: readonly DirectionalPressure[]): HorizonGroup[] {
  return HORIZON_ORDER.map((horizon) => ({
    horizon,
    tendencies: tendencies.filter((t) => t.earliestHorizon === horizon),
  })).filter((g) => g.tendencies.length > 0);
}

export interface ScenarioComparison {
  scenario: Scenario;
  applied: AppliedScenario;
  base: EvaluatedSystem;
  result: EvaluatedSystem;
  variableDeltas: VariableDelta[];
  loopDeltas: LoopDelta[];
  directional: DirectionalPressure[];
  directionalByHorizon: HorizonGroup[];
  /** Projections not drawn because an input is unknown (never zero-filled). */
  projectionsSkipped: SkippedProjection[];
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

/** A projection that could not be computed because an input is unknown.
 *  UNKNOWN IS NOT ZERO: we say which inputs are missing instead of
 *  substituting zeros and drawing a curve. */
export interface SkippedProjection {
  label: string;
  missingInputs: string[];
}

type ProjectionAttempt = { series: number[] } | { missing: string[] };

function requireAll(system: EvaluatedSystem, ids: readonly string[]): { values: Map<string, number>; missing: string[] } {
  const values = new Map<string, number>();
  const missing: string[] = [];
  for (const id of ids) {
    const v = num(system, id);
    if (v === null) missing.push(system.variableById.get(id)?.name ?? id);
    else values.set(id, v);
  }
  return { values, missing };
}

const CAREER_INPUTS = [
  INPUT_IDS.careerCapital,
  INPUT_IDS.qualityOfEffort,
  INPUT_IDS.protectedHours,
  INPUT_IDS.persistence,
  INPUT_IDS.effortToCapitalRate,
  INPUT_IDS.switchingCost,
  INPUT_IDS.switchingFrequency,
];
const CAPITAL_INPUTS = [
  INPUT_IDS.productiveAssets,
  DERIVED_IDS.totalIncome,
  INPUT_IDS.essentialExpenses,
  INPUT_IDS.discretionaryExpenses,
  INPUT_IDS.monthlyDebtPayments,
  INPUT_IDS.capitalConversionRate,
  INPUT_IDS.annualReturnRate,
];

function buildProjections(
  base: EvaluatedSystem,
  result: EvaluatedSystem,
  months: number,
): { projections: Projection[]; skipped: SkippedProjection[] } {
  const projections: Projection[] = [];
  const skipped: SkippedProjection[] = [];

  const career = (s: EvaluatedSystem): ProjectionAttempt => {
    const { values, missing } = requireAll(s, CAREER_INPUTS);
    if (missing.length) return { missing };
    const g = (id: string) => values.get(id)!;
    return {
      series: projectCareerCapital(g(INPUT_IDS.careerCapital), months, {
        qualityOfEffort: g(INPUT_IDS.qualityOfEffort),
        protectedHoursPerMonth: weeklyToMonthlyHours(g(INPUT_IDS.protectedHours)),
        persistence: g(INPUT_IDS.persistence),
        effortToCapitalRate: g(INPUT_IDS.effortToCapitalRate),
        switchingCostPerMonth: (g(INPUT_IDS.switchingCost) * g(INPUT_IDS.switchingFrequency)) / 12,
      }),
    };
  };
  const cb = career(base);
  const cr = career(result);
  if ("series" in cb && "series" in cr) {
    projections.push({ label: "Career capital (index)", unit: "index", assumptionIds: ["A6", "A15"], base: cb.series, scenario: cr.series });
  } else {
    skipped.push({ label: "Career capital (index)", missingInputs: [...new Set([...("missing" in cb ? cb.missing : []), ...("missing" in cr ? cr.missing : [])])] });
  }

  const capital = (s: EvaluatedSystem): ProjectionAttempt => {
    const { values, missing } = requireAll(s, CAPITAL_INPUTS);
    if (missing.length) return { missing };
    const g = (id: string) => values.get(id)!;
    return {
      series: projectProductiveCapital(g(INPUT_IDS.productiveAssets), months, {
        capitalConversionRate: g(INPUT_IDS.capitalConversionRate),
        monthlyIncome: g(DERIVED_IDS.totalIncome),
        monthlyExpenses: g(INPUT_IDS.essentialExpenses) + g(INPUT_IDS.discretionaryExpenses) + g(INPUT_IDS.monthlyDebtPayments),
        monthlyReturnRate: annualToMonthlyRate(g(INPUT_IDS.annualReturnRate)),
      }),
    };
  };
  const pb = capital(base);
  const pr = capital(result);
  if ("series" in pb && "series" in pr) {
    projections.push({ label: "Productive assets", unit: "$", assumptionIds: ["A7"], base: pb.series, scenario: pr.series });
  } else {
    skipped.push({ label: "Productive assets", missingInputs: [...new Set([...("missing" in pb ? pb.missing : []), ...("missing" in pr ? pr.missing : [])])] });
  }
  return { projections, skipped };
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
  const built = buildProjections(base, result, scenario.horizonMonths);

  return {
    scenario,
    applied,
    base,
    result,
    variableDeltas,
    loopDeltas,
    directional,
    directionalByHorizon: groupByHorizon(directional),
    projections: built.projections,
    projectionsSkipped: built.skipped,
    meanGapBefore: base.gap.meanNormalizedGap,
    meanGapAfter: result.gap.meanNormalizedGap,
  };
}
