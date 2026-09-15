/**
 * Apply scenario changes to a model. Only INPUT variables and declared
 * domain collections can be changed; derived variables are recomputed by
 * evaluation.
 * Returns a new model (the original is never mutated) plus a list of
 * changes that could not be applied.
 */
import { exactDate } from "@/calculations/time";
import { resolveValue } from "@/model/history";
import { collectionDefinitionFor, domainRegistry } from "@/model/domain";
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
  /** Names of declared collections the scenario changed (in memory only). */
  collectionsChanged: string[];
}

export function applyScenario(base: SystemModel, scenario: Scenario, options: ApplyOptions = {}): AppliedScenario {
  const now = options.now ?? new Date().toISOString();
  const model: SystemModel = {
    ...base,
    variables: base.variables.map((v) => ({ ...v, values: [...v.values] })),
    collections: Object.fromEntries(Object.entries(base.collections).map(([name, c]) => [name, { ...c, items: c.items.map((it) => ({ ...it })) }])),
  };
  const domain = domainRegistry.get(base.domainDefinitionId, base.domainDefinitionVersion);
  /** A collection may be changed only when the active domain declares it
   *  and the stored envelope is the domain's (never a preserved legacy one). */
  const declaredCollection = (change: ScenarioChange, name: string) => {
    const def = collectionDefinitionFor(domain, name);
    if (!domain) {
      rejected.push({ change, reason: `Collection "${name}" cannot be changed: this system's domain is not available.` });
      return null;
    }
    if (!def) {
      rejected.push({ change, reason: `Collection "${name}" is not declared by this domain.` });
      return null;
    }
    const envelope = model.collections[name] ?? { items: [], origin: "domain" as const };
    if (envelope.origin !== "domain") {
      rejected.push({ change, reason: `Collection "${name}" holds preserved records from an older format and cannot be changed here.` });
      return null;
    }
    model.collections[name] = envelope;
    return { def, envelope };
  };
  /** The value that applies now (the scenario is hypothetical: entries it
   *  appends live only in this in-memory copy and are never saved). */
  const currentOf = (v: SystemModel["variables"][number]) => resolveValue(v.values, now);
  const rejected: AppliedScenario["rejected"] = [];
  const changedVariables = new Map<string, 1 | -1>();
  const collectionsChanged = new Set<string>();

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
      case "addCollectionItem": {
        const target = declaredCollection(change, change.collection);
        if (!target) break;
        if (target.envelope.items.some((it) => it.id === change.item.id)) {
          rejected.push({ change, reason: `Item "${change.item.id}" already exists in ${change.collection}` });
          break;
        }
        const parsed = target.def.itemSchema.safeParse(change.item);
        if (!parsed.success) {
          rejected.push({ change, reason: `Item does not match the ${change.collection} schema: ${parsed.error.issues.map((i) => i.message).join("; ")}` });
          break;
        }
        target.envelope.items.push(parsed.data);
        collectionsChanged.add(change.collection);
        break;
      }
      case "updateCollectionItem": {
        const target = declaredCollection(change, change.collection);
        if (!target) break;
        const idx = target.envelope.items.findIndex((it) => it.id === change.itemId);
        if (idx < 0) {
          rejected.push({ change, reason: `Unknown item "${change.itemId}" in ${change.collection}` });
          break;
        }
        const parsed = target.def.itemSchema.safeParse({ ...target.envelope.items[idx], ...change.patch, id: change.itemId });
        if (!parsed.success) {
          rejected.push({ change, reason: `Change does not match the ${change.collection} schema: ${parsed.error.issues.map((i) => i.message).join("; ")}` });
          break;
        }
        target.envelope.items[idx] = parsed.data;
        collectionsChanged.add(change.collection);
        break;
      }
      case "removeCollectionItem": {
        const target = declaredCollection(change, change.collection);
        if (!target) break;
        const idx = target.envelope.items.findIndex((it) => it.id === change.itemId);
        if (idx < 0) {
          rejected.push({ change, reason: `Unknown item "${change.itemId}" in ${change.collection}` });
          break;
        }
        target.envelope.items.splice(idx, 1);
        collectionsChanged.add(change.collection);
        break;
      }
    }
  }
  return { model, rejected, changedVariables, collectionsChanged: [...collectionsChanged].sort() };
}
