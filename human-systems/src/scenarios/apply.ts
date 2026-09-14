/**
 * Apply scenario changes to a model. Only INPUT variables and income
 * sources can be changed; derived variables are recomputed by evaluation.
 * Returns a new model (the original is never mutated) plus a list of
 * changes that could not be applied.
 */
import { DERIVED_BY_ID } from "@/model/derived";
import type { Scenario, ScenarioChange, SystemModel } from "@/types";

export interface AppliedScenario {
  model: SystemModel;
  rejected: { change: ScenarioChange; reason: string }[];
  /** Input variable ids whose value changed, with the sign of the change. */
  changedVariables: Map<string, 1 | -1>;
  incomeSourcesChanged: boolean;
}

export function applyScenario(base: SystemModel, scenario: Scenario): AppliedScenario {
  const model: SystemModel = {
    ...base,
    variables: base.variables.map((v) => ({ ...v })),
    incomeSources: base.incomeSources.map((s) => ({ ...s })),
  };
  const rejected: AppliedScenario["rejected"] = [];
  const changedVariables = new Map<string, 1 | -1>();
  let incomeSourcesChanged = false;

  const setVariable = (change: ScenarioChange, id: string, next: (current: number | null) => number) => {
    const v = model.variables.find((x) => x.id === id);
    if (!v) return rejected.push({ change, reason: `Unknown variable ${id}` });
    if (v.kind === "derived" || DERIVED_BY_ID[id]) {
      return rejected.push({
        change,
        reason: `${v.name} is calculated from other variables; change its inputs instead.`,
      });
    }
    const value = next(v.currentValue);
    if (!Number.isFinite(value)) return rejected.push({ change, reason: "Value is not a finite number" });
    const before = v.currentValue;
    v.currentValue = value;
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
        if (target && target.kind === "input" && target.currentValue === null) {
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
