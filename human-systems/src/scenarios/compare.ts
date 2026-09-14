/**
 * Structural scenario analysis: evaluate base and scenario models and
 * report what changed. This is NOT a prediction — the outputs are derived
 * values under the same model assumptions, plus directional tendencies
 * (A12) and loop-pressure deltas (A10).
 */
import { HORIZON_ORDER, propagateDirectionalPressure, type DirectionalPressure, type Horizon } from "@/calculations";
import { resolveVariable, type ProjectionDefinition } from "@/model/domain";
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
  /** Counts only: no mean gap exists (a mean would be a universal score). */
  gapsShrinking: number;
  gapsGrowing: number;
  openGapsBefore: number;
  openGapsAfter: number;
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

/** A projection that could not be computed because an input is unknown.
 *  UNKNOWN IS NOT ZERO: we say which inputs are missing instead of
 *  substituting zeros and drawing a curve. */
export interface SkippedProjection {
  label: string;
  subjectId: string;
  missingInputs: string[];
}

function projectionSubjects(system: EvaluatedSystem, def: ProjectionDefinition): string[] {
  if (def.scope === "system") return [system.model.id];
  return system.model.profile.members.filter((m) => m.status === "active").map((m) => m.id);
}

function attemptProjection(
  system: EvaluatedSystem,
  def: ProjectionDefinition,
  subjectId: string,
  months: number,
): { series: number[] } | { missing: string[] } {
  const values = new Map<string, number>();
  const missing: string[] = [];
  for (const input of def.inputs) {
    const ref = { key: input.key, subjectId: input.scope === "system" ? null : subjectId };
    const v = resolveVariable(system.variables, system.model.id, ref);
    if (!v || v.currentValue === null) missing.push(v?.name ?? input.key);
    else values.set(input.key, v.currentValue);
  }
  if (missing.length) return { missing };
  return { series: def.compute(values, months) };
}

function buildProjections(
  base: EvaluatedSystem,
  result: EvaluatedSystem,
  months: number,
): { projections: Projection[]; skipped: SkippedProjection[] } {
  const projections: Projection[] = [];
  const skipped: SkippedProjection[] = [];
  const memberLabel = (id: string) => base.model.profile.members.find((m) => m.id === id)?.label ?? id;
  for (const def of base.domain.projections) {
    for (const subjectId of projectionSubjects(base, def)) {
      const label = def.scope === "system" ? def.label : `${def.label} — ${memberLabel(subjectId)}`;
      const b = attemptProjection(base, def, subjectId, months);
      const r = attemptProjection(result, def, subjectId, months);
      if ("series" in b && "series" in r) {
        projections.push({ label, unit: def.unit, assumptionIds: def.assumptionIds, base: b.series, scenario: r.series });
      } else {
        const missing = [...new Set([...("missing" in b ? b.missing : []), ...("missing" in r ? r.missing : [])])];
        skipped.push({ label, subjectId, missingInputs: missing });
      }
    }
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
    gapsShrinking: variableDeltas.filter((d) => d.baseGap !== null && d.scenarioGap !== null && d.scenarioGap < d.baseGap - 1e-9).length,
    gapsGrowing: variableDeltas.filter((d) => d.baseGap !== null && d.scenarioGap !== null && d.scenarioGap > d.baseGap + 1e-9).length,
    openGapsBefore: base.gap.openCount,
    openGapsAfter: result.gap.openCount,
  };
}
