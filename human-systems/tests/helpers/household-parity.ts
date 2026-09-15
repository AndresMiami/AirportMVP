/**
 * Semantic fingerprint of the evaluated sample household. Captures MEANING
 * (values, unknown states, loops, feasibility, leverage ranks, signature
 * dimensions, histories), normalises ordering that carries no meaning, and
 * rounds floats so presentation changes cannot break it.
 */
import { createSampleHousehold } from "@/data/sample-household";
import { evaluateSystem } from "@/model/evaluate";
import { computeSignature } from "@/signatures/compute";

export const PARITY_NOW = "2026-09-15T12:00:00.000Z";

const r6 = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6);
const sortBy = <T>(xs: T[], key: (t: T) => string): T[] => [...xs].sort((a, b) => key(a).localeCompare(key(b)));

export function householdParityFingerprint(): Record<string, unknown> {
  const model = createSampleHousehold();
  const ev = evaluateSystem(model, { now: PARITY_NOW });

  const inputs = Object.fromEntries(
    sortBy(ev.variables.filter((v) => v.kind === "input"), (v) => v.id).map((v) => [
      v.id,
      {
        key: v.key,
        subjectId: v.subjectId,
        currentValue: r6(v.currentValue),
        desiredValue: r6(v.desiredValue),
        targetMode: v.targetMode,
        sourceType: v.sourceType,
        confidence: r6(v.confidence),
        valueResolution: v.valueResolution,
        targetResolution: v.targetResolution,
        unit: v.unit,
      },
    ]),
  );
  const derived = Object.fromEntries(
    sortBy(ev.derived, (c) => c.variable.id).map((c) => [
      c.variable.id,
      { subjectId: c.subjectId, value: r6(c.variable.currentValue), confidence: r6(c.variable.confidence), desired: r6(c.variable.desiredValue), missingInputs: [...c.missingInputs].sort() },
    ]),
  );
  const loops = sortBy(ev.loops, (l) => l.id).map((l) => ({
    id: l.id,
    polarity: l.polarity,
    variableIds: l.variableIds,
    status: l.status,
    gain: r6(l.gain),
    pressure: r6(l.pressure),
  }));
  const actions = sortBy(ev.actions, (a) => a.action.id).map((a) => ({
    id: a.action.id,
    feasible: a.feasibility.feasible,
    hardViolations: a.feasibility.hardViolations.map((v) => v.constraint.id).sort(),
    softViolations: a.feasibility.softViolations.map((v) => v.constraint.id).sort(),
    suitability: r6(a.feasibility.suitability),
    leverage: r6(a.leverage.score),
    utilityTotal: r6(a.utility.weightedTotal),
    utility: Object.fromEntries(a.utility.dimensions.filter((d) => d.value !== null).map((d) => [d.dimension, r6(d.value)])),
  }));
  const leverageRank = [...ev.actions].sort((a, b) => b.leverage.score - a.leverage.score || a.action.id.localeCompare(b.action.id)).map((a) => a.action.id);
  const gap = { openCount: ev.gap.openCount, closedCount: ev.gap.closedCount, gaps: sortBy(ev.gap.gaps, (g) => g.variableId).map((g) => ({ id: g.variableId, normalized: r6(g.normalizedGap) })) };
  const signature = (subjectId: string) =>
    Object.fromEntries(
      computeSignature(ev, { id: `sig_${subjectId}`, now: PARITY_NOW, mode: "current", subjectId }).dimensions.map((d) => [
        d.dimensionId,
        { state: d.state, value: r6(d.normalizedValue), band: d.bandState, confidence: r6(d.confidence), missing: [...d.missingInformation].sort() },
      ]),
    );
  const histories = Object.fromEntries(
    sortBy(model.variables, (v) => v.id).map((v) => [
      v.id,
      {
        values: v.values.map((e) => ({ value: e.value, valid: e.valid, basis: e.validBasis, recordedAt: e.recordedAt, sourceType: e.sourceType, confidence: e.confidence, status: e.status })),
        targets: v.targets.map((t) => ({ desiredValue: t.desiredValue, mode: t.targetMode, valid: t.valid, basis: t.validBasis, status: t.status })),
      },
    ]),
  );
  const references = {
    hypotheses: sortBy(model.hypotheses, (h) => h.id).map((h) => ({ id: h.id, kind: h.kind, status: h.status, loopId: h.loopId ?? null, relationshipIds: [...h.relationshipIds].sort() })),
    events: sortBy(model.events, (e) => e.id).map((e) => ({ id: e.id, kind: e.kind, subjectId: e.subjectId, links: e.links })),
    relationships: sortBy(model.relationships, (r) => r.id).map((r) => ({ id: r.id, kind: r.kind, dynamics: r.participatesInDynamics, from: r.sourceVariableId, to: r.targetVariableId, direction: r.direction })),
  };
  return {
    domain: { id: ev.domain.id, version: ev.domain.version },
    counts: { inputs: Object.keys(inputs).length, derived: Object.keys(derived).length, loops: loops.length, actions: actions.length, unassigned: ev.unassignedVariables.length, issuesWarning: ev.issues.filter((i) => i.level === "warning").length },
    inputs,
    derived,
    loops,
    actions,
    leverageRank,
    gap,
    signatures: { system: signature(model.id), dani: signature("dani") },
    histories,
    references,
  };
}
