/**
 * Apply scenario changes to a model. Only INPUT variables and income
 * sources can be changed; derived variables are recomputed by evaluation.
 * Returns a new model (the original is never mutated) plus a list of
 * changes that could not be applied.
 */
import { exactDate } from "@/calculations/time";
import { resolveValue } from "@/model/history";
import type { Scenario, ScenarioChange, SystemModel, ValueEntry } from "@/types";

export interface ApplyOptions {
  /** The clock the scenario is applied at (defaults to the real clock). */
  now?: string;
}

export interface AppliedScenario {
  model: SystemModel;
  rejected: { change: ScenarioChange; reason: string }[];
  /** Input variable ids whose value changed, with the sign of the change. */
  changedVariables: Map<string, 1 | -1>;
  incomeSourcesChanged: boolean;
}

export function applyScenario(base: SystemModel, scenario: Scenario, options: ApplyOptions = {}): AppliedScenario {
  const now = options.now ?? new Date().toISOString();
  const model: SystemModel = {
    ...base,
    variables: base.variables.map((v) => ({ ...v, values: [...v.values] })),
    incomeSources: base.incomeSources.map((s) => ({ ...s })),
  };
  /** The value that applies now (the scenario is hypothetical: entries it
   *  appends live only in this in-memory copy and are never saved). */
  const currentOf = (v: SystemModel["variables"][number]) => resolveValue(v.values, now);
  const rejected: AppliedScenario["rejected"] = [];
  const changedVariables = new Map<string, 1 | -1>();
  let incomeSourcesChanged = false;

  const setVariable = (change: ScenarioChange, id: string, next: (current: number | null) => number) => {
    const v = model.variables.find((x) => x.id === id);
    if (!v) return rejected.push({ change, reason: `Unknown variable ${id}` });
    if (v.kind === "derived") {
      return rejected.push({
        change,
        reason: `${v.name} is calculated from other variables; change its inputs instead.`,
      });
    }
    const resolved = currentOf(v);
    const before = resolved.entry ? resolved.entry.value : null;
    const value = next(before);
    if (!Number.isFinite(value)) return rejected.push({ change, reason: "Value is not a finite number" });
    const entry: ValueEntry = {
      id: `${v.id}__scenario_${v.values.length + 1}`,
      value,
      valid: exactDate(now.slice(0, 10), "scenario (now)"),
      validBasis: "asserted",
      recordedAt: now,
      sourceType: "estimated",
      confidence: resolved.entry?.confidence ?? 0.5,
      evidence: [],
      observationIds: [],
      note: "Scenario change (hypothetical; not stored)",
      status: "active",
    };
    // A same-day scenario entry must win: make it the latest by instant.
    entry.valid = { kind: "instant", start: now, precision: "datetime", text: "scenario (now)" };
    v.values.push(entry);
    if (before === null || value > before) changedVariables.set(id, 1);
    else if (value < before) changedVariables.set(id, -1);
  };

  for (const change of scenario.changes) {
    switch (change.kind) {
      case "setVariable":
        setVariable(change, change.variableId, () => change.value);
        break;
      case "adjustVariable": {
        // UNKNOWN IS NOT ZERO: a delta on a variable with no value cannot be
        // applied; set a value instead.
        const target = model.variables.find((x) => x.id === change.variableId);
        if (target && target.kind === "input" && (currentOf(target).entry?.value ?? null) === null) {
          rejected.push({ change, reason: `${target.name} has no current value; set a value instead of adjusting it.` });
          break;
        }
        setVariable(change, change.variableId, (c) => (c ?? 0) + change.delta);
        break;
      }
      case "setIncomeSourceAmount": {
        const s = model.incomeSources.find((x) => x.id === change.incomeSourceId);
        if (!s) {
          rejected.push({ change, reason: `Unknown income source ${change.incomeSourceId}` });
          break;
        }
        s.monthlyAmount = change.monthlyAmount;
        incomeSourcesChanged = true;
        break;
      }
      case "addIncomeSource":
        if (model.incomeSources.some((x) => x.id === change.source.id)) {
          rejected.push({ change, reason: `Income source ${change.source.id} already exists` });
          break;
        }
        model.incomeSources.push({ ...change.source });
        incomeSourcesChanged = true;
        break;
      case "removeIncomeSource": {
        const idx = model.incomeSources.findIndex((x) => x.id === change.incomeSourceId);
        if (idx < 0) {
          rejected.push({ change, reason: `Unknown income source ${change.incomeSourceId}` });
          break;
        }
        model.incomeSources.splice(idx, 1);
        incomeSourcesChanged = true;
        break;
      }
    }
  }
  return { model, rejected, changedVariables, incomeSourcesChanged };
}
