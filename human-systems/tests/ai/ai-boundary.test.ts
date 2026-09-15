import { describe, expect, it } from "vitest";
import { MockAiProvider, NEUTRAL_EXAMPLE_ANALYSIS } from "@/ai/mock-provider";
import { HOUSEHOLD_AI_EXAMPLE } from "@/domains/household/ai-example";
import { HOUSEHOLD_DOMAIN } from "@/domains/household/definition";
import { categoryVocabulary } from "@/model/domain";

const MOCK_ANALYSIS_JSON = HOUSEHOLD_AI_EXAMPLE;
const HOUSEHOLD_CATEGORIES = categoryVocabulary(HOUSEHOLD_DOMAIN);
import { ANALYSIS_SYSTEM_PROMPT } from "@/ai/prompt";
import { AiAnalysisSchema, parseAiAnalysis } from "@/ai/schema";

describe("AI output validation", () => {
  it("accepts the mock payload and strips a code fence", () => {
    const r = parseAiAnalysis("```json\n" + JSON.stringify(MOCK_ANALYSIS_JSON) + "\n```");
    expect(r.ok).toBe(true);
  });
  it("rejects non-JSON and shape violations", () => {
    expect(parseAiAnalysis("not json").ok).toBe(false);
    expect(parseAiAnalysis(JSON.stringify({ observations: [] })).ok).toBe(false);
    const badCategory = { ...MOCK_ANALYSIS_JSON, candidate_variables: [{ ...MOCK_ANALYSIS_JSON.candidate_variables[0], category: "vibes" }] };
    // the category vocabulary belongs to the domain: unknown words are refused when the vocabulary is given
    expect(parseAiAnalysis(JSON.stringify(badCategory), { categories: HOUSEHOLD_CATEGORIES }).ok).toBe(false);
    expect(parseAiAnalysis(JSON.stringify(MOCK_ANALYSIS_JSON), { categories: HOUSEHOLD_CATEGORIES }).ok).toBe(true);
    // the household example uses household words (agency), which a domain without them refuses
    expect(parseAiAnalysis(JSON.stringify(MOCK_ANALYSIS_JSON), { categories: ["event", "structure"] }).ok).toBe(false);
    const badConfidence = { ...MOCK_ANALYSIS_JSON, candidate_variables: [{ ...MOCK_ANALYSIS_JSON.candidate_variables[0], confidence: 7 }] };
    expect(AiAnalysisSchema.safeParse(badConfidence).success).toBe(false);
  });
  it("mock provider never invents numbers: statedValue is null unless the text stated one", () => {
    const stated = MOCK_ANALYSIS_JSON.candidate_variables.filter((c: { statedValue: number | null }) => c.statedValue !== null);
    expect(stated).toHaveLength(1);
    expect(stated[0].statedValue).toBe(10000);
    expect(MOCK_ANALYSIS_JSON.candidate_variables.every((c) => String(c.evidence).length > 0)).toBe(true);
  });
  it("rejects any attempt to return a structural signature or score (strict keys)", () => {
    const withSignature = { ...MOCK_ANALYSIS_JSON, structural_signature: "10110010" };
    expect(AiAnalysisSchema.safeParse(withSignature).success).toBe(false);
    const withScore = { ...MOCK_ANALYSIS_JSON, life_score: 0.7 };
    expect(AiAnalysisSchema.safeParse(withScore).success).toBe(false);
  });
  it("accepts candidate dimensions and uncertainty questions, defaulting them when absent", () => {
    const { candidate_structural_dimensions: _d, questions_to_reduce_uncertainty: _q, ...legacy } = MOCK_ANALYSIS_JSON;
    void _d;
    void _q;
    const parsed = AiAnalysisSchema.parse(legacy);
    expect(parsed.candidate_structural_dimensions).toEqual([]);
    expect(parsed.questions_to_reduce_uncertainty).toEqual([]);
    const full = AiAnalysisSchema.parse(MOCK_ANALYSIS_JSON);
    expect(full.candidate_structural_dimensions[0].name).toBe("Goal-directed saving capacity");
    expect(full.questions_to_reduce_uncertainty[0].expectedInformationGain).toBe("high");
    const badGain = { ...MOCK_ANALYSIS_JSON, questions_to_reduce_uncertainty: [{ ...MOCK_ANALYSIS_JSON.questions_to_reduce_uncertainty[0], expectedInformationGain: "huge" }] };
    expect(AiAnalysisSchema.safeParse(badGain).success).toBe(false);
  });
  it("provider returns a validated analysis", async () => {
    const r = await new MockAiProvider().analyze({ text: "anything" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.analysis.candidate_variables.length).toBeGreaterThan(0);
    // the neutral default assumes no kind of system
    expect(JSON.stringify(NEUTRAL_EXAMPLE_ANALYSIS)).not.toMatch(/income|career|household|family|job/i);
    const household = await new MockAiProvider(HOUSEHOLD_AI_EXAMPLE).analyze({ text: "anything" });
    expect(household.ok && household.analysis.candidate_structural_dimensions[0].name).toBe("Goal-directed saving capacity");
  });
  it("system prompt carries the required stance", () => {
    for (const phrase of ["Separate observations from interpretations", "Do not moralize", "Do not assume motivation from leisure behavior", "Identify uncertainty explicitly", "never assign a structural signature"]) {
      expect(ANALYSIS_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
