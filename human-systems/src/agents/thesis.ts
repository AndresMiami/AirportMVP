/**
 * A THESIS is a hypothesis the person keeps, read as what it watches: its
 * predictions and kill criteria that name a variable. A collector binds
 * evidence to those targets by STABLE id: a kill criterion has one; a
 * prediction uses its own `id` when set, else a content-derived id, so an
 * edited prediction is a different target (and a pending capture for the
 * old wording goes stale through the hypothesis basis). Pure.
 */
import { contentHash } from "@/ai/hash";
import { canonicalJSON } from "@/kernel/revision";
import type { Hypothesis, HypothesisPrediction, StoredVariable, SystemModel } from "@/types";

export interface ThesisTarget {
  id: string;
  kind: "prediction" | "kill_criterion";
  statement: string;
  variableId: string;
}

export interface Thesis {
  id: string;
  statement: string;
  status: Hypothesis["status"];
  targets: ThesisTarget[];
}

export function predictionId(p: HypothesisPrediction): string {
  return p.id ?? `pred_${contentHash(canonicalJSON({ statement: p.statement, variableId: p.variableId ?? null, expectedDirection: p.expectedDirection ?? null, by: p.by ?? null }))}`;
}

/** The thesis view of a hypothesis: only targets that name a variable can receive evidence. */
export function thesisOf(h: Hypothesis): Thesis {
  const targets: ThesisTarget[] = [];
  for (const p of h.predictions) if (p.variableId) targets.push({ id: predictionId(p), kind: "prediction", statement: p.statement, variableId: p.variableId });
  for (const k of h.killCriteria) if (k.variableId) targets.push({ id: k.id, kind: "kill_criterion", statement: k.statement, variableId: k.variableId });
  return { id: h.id, statement: h.statement, status: h.status, targets };
}

/** Targets whose variable exists and takes entered values. */
export function collectableTargets(thesis: Thesis, model: SystemModel): { target: ThesisTarget; variable: StoredVariable }[] {
  const out: { target: ThesisTarget; variable: StoredVariable }[] = [];
  for (const target of thesis.targets) {
    const variable = model.variables.find((v) => v.id === target.variableId);
    if (variable && variable.kind === "input") out.push({ target, variable });
  }
  return out;
}

/** Hypotheses a collector can work for: not rejected, with at least one collectable target. */
export function theses(model: SystemModel): { hypothesis: Hypothesis; thesis: Thesis; collectable: number }[] {
  return model.hypotheses
    .filter((h) => h.status !== "rejected")
    .map((h) => {
      const thesis = thesisOf(h);
      return { hypothesis: h, thesis, collectable: collectableTargets(thesis, model).length };
    })
    .filter((t) => t.collectable > 0);
}
