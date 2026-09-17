/**
 * Deterministic provider for development and tests. It does not call any
 * network. It returns the example analysis it was constructed with (a
 * domain pack may supply one through its prompt fragment); the default is
 * a neutral example that assumes no kind of system.
 */
import type { AiProvider, AnalysisRequest } from "./provider";
import { AiAnalysisSchema, type ParseResult } from "./schema";

/** A neutral example: two quantities and one relationship, no domain words. */
export const NEUTRAL_EXAMPLE_ANALYSIS = {
  observations: [{ text: "Quantity A was recorded as 12.", quote: "A is 12" }],
  candidate_variables: [
    {
      name: "Quantity A",
      description: "A recorded input of the system.",
      category: "event",
      changeSpeed: "fast",
      statedValue: 12,
      qualitativeValue: "stated as 12",
      unit: "units",
      evidence: "A is 12",
      confidence: 0.6,
      caveat: "Stated once; not yet measured.",
    },
    {
      name: "Quantity B",
      description: "A slower condition the text mentions without a number.",
      category: "structure",
      changeSpeed: "slow",
      statedValue: null,
      qualitativeValue: "apparently steady",
      unit: "units",
      evidence: "B has been about the same for a while",
      confidence: 0.4,
      caveat: "No value stated.",
    },
  ],
  candidate_relationships: [
    {
      sourceVariable: "Quantity A",
      targetVariable: "Quantity B",
      direction: "positive",
      strengthEstimate: 0.4,
      lagEstimate: { value: 2, unit: "months" },
      explanation: "The text says B tends to follow A.",
      confidence: 0.4,
    },
  ],
  candidate_constraints: [],
  possible_feedback_loops: [],
  missing_information: ["A measured value for Quantity B."],
  contradictions: [],
  confidence_notes: ["One observation supports each candidate."],
  candidate_structural_dimensions: [],
  questions_to_reduce_uncertainty: [
    { question: "What is the current value of Quantity B?", whyItMatters: "Nothing depending on B can be evaluated without it.", expectedInformationGain: "high" },
  ],
};

export class MockAiProvider implements AiProvider {
  readonly name = "mock";
  constructor(private readonly example: unknown = NEUTRAL_EXAMPLE_ANALYSIS) {}
  async analyze(_request: AnalysisRequest): Promise<ParseResult> {
    void _request;
    const parsed = AiAnalysisSchema.safeParse(this.example);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    return { ok: true, analysis: parsed.data };
  }
}
