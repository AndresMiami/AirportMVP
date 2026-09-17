/**
 * Existing hypotheses that are DETERMINISTICALLY linked to a variable:
 * through a prediction or kill criterion naming it, a relationship whose
 * edge touches it, or an observation linked to both. Never through text
 * similarity: a hypothesis that merely mentions the variable's name is not
 * linked. (A future `explains` field on Hypothesis makes this explicit.)
 */
import type { Hypothesis, SystemModel } from "@/types";

export type HypothesisLinkKind = "prediction" | "kill_criterion" | "relationship" | "supporting_observation" | "contradicting_observation" | "observation_link";

export interface LinkedHypothesis {
  hypothesis: Hypothesis;
  linkedVia: HypothesisLinkKind[];
}

export function linkedHypotheses(model: SystemModel, variableId: string): LinkedHypothesis[] {
  const edgesTouching = new Set(model.relationships.filter((r) => r.sourceVariableId === variableId || r.targetVariableId === variableId).map((r) => r.id));
  const observationsNaming = new Set(model.observations.filter((o) => o.links.variableIds.includes(variableId)).map((o) => o.id));
  const out: LinkedHypothesis[] = [];
  for (const h of model.hypotheses) {
    const via: HypothesisLinkKind[] = [];
    if (h.predictions.some((p) => p.variableId === variableId)) via.push("prediction");
    if (h.killCriteria.some((k) => k.variableId === variableId)) via.push("kill_criterion");
    if (h.relationshipIds.some((id) => edgesTouching.has(id))) via.push("relationship");
    if (h.supportingObservationIds.some((id) => observationsNaming.has(id))) via.push("supporting_observation");
    if (h.contradictingObservationIds.some((id) => observationsNaming.has(id))) via.push("contradicting_observation");
    if (model.observations.some((o) => o.links.hypothesisIds.includes(h.id) && observationsNaming.has(o.id))) via.push("observation_link");
    if (via.length > 0) out.push({ hypothesis: h, linkedVia: via });
  }
  return out;
}
