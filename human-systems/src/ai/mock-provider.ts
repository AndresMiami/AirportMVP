/**
 * Deterministic provider for development and tests. It does not call any
 * network. Its output mirrors the example in the working concept so the
 * review-screen contract can be built and tested before a real provider.
 */
import type { AiProvider, AnalysisRequest } from "./provider";
import { AiAnalysisSchema, type ParseResult } from "./schema";

export const MOCK_ANALYSIS_JSON = {
  observations: [
    { text: "Works four days per week.", quote: "works four days per week" },
    {
      text: "Spends much free time sleeping or playing games.",
      quote: "spends much of his free time sleeping or playing games",
    },
    {
      text: "Has saved $10,000 over 18 months toward buying a car.",
      quote: "saved $10,000 over 18 months toward buying a car",
    },
  ],
  candidate_variables: [
    {
      name: "Saving discipline",
      description: "Ability to accumulate money toward a defined objective.",
      category: "agency",
      changeSpeed: "slow",
      qualitativeValue: "likely high",
      statedValue: null,
      unit: "",
      evidence: "$10,000 accumulated toward a defined objective over 18 months.",
      confidence: 0.85,
      caveat: "The saving rate relative to income is unknown.",
    },
    {
      name: "Career-development activity during free time",
      description: "Time in free hours spent on activities that build career capital.",
      category: "asset",
      changeSpeed: "slow",
      qualitativeValue: "apparently low",
      statedValue: null,
      unit: "",
      evidence: "Reported current free-time activities (sleeping, games).",
      confidence: 0.65,
      caveat: "Rest may be recovery from physical work; this is not a motivation judgment.",
    },
    {
      name: "Liquid savings",
      description: "Money set aside, currently earmarked for a car.",
      category: "buffer",
      changeSpeed: "slow",
      qualitativeValue: "stated",
      statedValue: 10000,
      unit: "$",
      evidence: "Stated directly: $10,000.",
      confidence: 0.9,
      caveat: "Earmarked for a purchase, so it may not function as an emergency buffer.",
    },
  ],
  candidate_relationships: [
    {
      sourceVariable: "Saving discipline",
      targetVariable: "Liquid savings",
      direction: "positive",
      strengthEstimate: 0.7,
      lagEstimate: { value: 1, unit: "months" },
      explanation: "Consistent saving behaviour accumulates reserves.",
      confidence: 0.7,
    },
  ],
  candidate_constraints: [],
  possible_feedback_loops: [],
  missing_information: [
    "Monthly income and essential expenses.",
    "Whether the four-day schedule is chosen or imposed.",
    "Physical demands of the work (relevant to interpreting rest time).",
  ],
  contradictions: [],
  confidence_notes: [
    "Leisure behaviour is reported, not interpreted as motivation.",
  ],
};

export class MockAiProvider implements AiProvider {
  readonly name = "mock";
  async analyze(_request: AnalysisRequest): Promise<ParseResult> {
    void _request;
    const parsed = AiAnalysisSchema.safeParse(MOCK_ANALYSIS_JSON);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    return { ok: true, analysis: parsed.data };
  }
}
