/**
 * Question-selection heuristic (assumption A22): which dimension is worth
 * learning about NEXT.
 *
 *   priority = importance × uncertainty × influence
 *
 *   importance  = the definition's 0..1 importance for the dimension
 *   uncertainty = 1 when the dimension is unknown, else 1 - confidence
 *   influence   = max(0.1, 0.5 × mean network influence of the dimension's
 *                 variables that are in the model + 0.5 × share of detected
 *                 loops touching any of them)
 *
 * Multiplicative, no division: a zero anywhere means "nothing to learn"
 * (importance 0) or "we already know" (confidence 1), and the influence
 * floor keeps an unknown but isolated dimension askable. This is a MODEL
 * HEURISTIC, not an information-theoretic quantity.
 */
import type { EvaluatedSystem } from "@/model/evaluate";
import type { SignatureDefinition, StructuralSignature } from "@/types/signature";

export const INFLUENCE_FLOOR = 0.1;

export interface QuestionPriority {
  dimensionId: string;
  name: string;
  importance: number;
  uncertainty: number;
  influence: number;
  priority: number;
  /** Why this dimension is uncertain. */
  reason: string;
  /** The single next question, taken from the definition. */
  question: string;
  /** Which variable the question is about. */
  targetVariableId: string;
  state: "unknown" | "known";
  confidence: number;
}

export function questionPriorities(
  evaluated: EvaluatedSystem,
  signature: StructuralSignature,
  definition: SignatureDefinition,
): QuestionPriority[] {
  const loops = evaluated.loops;
  return definition.dimensions
    .map((def): QuestionPriority | null => {
      const snap = signature.dimensions.find((d) => d.dimensionId === def.id);
      if (!snap) return null;
      const present = def.inputs.filter((i) => evaluated.variableById.has(i.variableId)).map((i) => i.variableId);
      const meanInfluence = present.length
        ? present.reduce((s, id) => s + (evaluated.networkInfluence.get(id) ?? 0), 0) / present.length
        : 0;
      const loopShare = loops.length
        ? loops.filter((l) => l.variableIds.some((v) => present.includes(v))).length / loops.length
        : 0;
      const influence = Math.max(INFLUENCE_FLOOR, 0.5 * meanInfluence + 0.5 * loopShare);
      const uncertainty = snap.state === "unknown" ? 1 : 1 - snap.confidence;
      const importance = def.importance;
      const priority = importance * uncertainty * influence;

      // The question targets the most informative input: a missing required
      // input first, then any missing input, then the least confident one.
      const missingRequired = snap.contributions.find((c) => c.required && c.normalized === null);
      const missingAny = snap.contributions.find((c) => c.normalized === null);
      const leastConfident = [...snap.contributions]
        .filter((c) => c.normalized !== null)
        .sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))[0];
      const target = missingRequired ?? missingAny ?? leastConfident ?? snap.contributions[0];
      const input = def.inputs.find((i) => i.variableId === target.variableId)!;
      let reason: string;
      if (snap.state === "unknown") reason = snap.explanation;
      else if (target.normalized === null) reason = `${target.name} has no value; the dimension rests on ${snap.contributions.length - snap.missingInformation.length} of ${snap.contributions.length} inputs.`;
      else
        reason = `Confidence ${Math.round(snap.confidence * 100)}%: ${target.name} is ${target.sourceType?.replace("_", " ") ?? "of unknown provenance"} at ${Math.round((target.confidence ?? 0) * 100)}% confidence.`;
      return {
        dimensionId: def.id,
        name: def.name,
        importance,
        uncertainty,
        influence,
        priority,
        reason,
        question: input.question,
        targetVariableId: target.variableId,
        state: snap.state,
        confidence: snap.confidence,
      };
    })
    .filter((q): q is QuestionPriority => q !== null)
    .sort((a, b) => b.priority - a.priority || a.dimensionId.localeCompare(b.dimensionId));
}

/** One-sentence summary contrasting a well-known and a poorly-known dimension. */
export function understandingSummary(priorities: readonly QuestionPriority[]): string | null {
  if (priorities.length < 2) return null;
  const best = [...priorities].sort((a, b) => a.uncertainty - b.uncertainty)[0];
  const worst = priorities[0];
  if (best.dimensionId === worst.dimensionId) return null;
  const worstPhrase = worst.state === "unknown" ? "insufficient information about" : "low confidence in";
  return `${best.name} is understood reasonably well (confidence ${Math.round(best.confidence * 100)}%), but there is ${worstPhrase} ${worst.name.toLowerCase()}.`;
}
