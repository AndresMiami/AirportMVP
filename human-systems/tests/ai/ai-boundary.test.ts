import { describe, expect, it } from "vitest";
import { MockAiProvider, MOCK_ANALYSIS_JSON } from "@/ai/mock-provider";
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
    expect(parseAiAnalysis(JSON.stringify(badCategory)).ok).toBe(false);
    const badConfidence = { ...MOCK_ANALYSIS_JSON, candidate_variables: [{ ...MOCK_ANALYSIS_JSON.candidate_variables[0], confidence: 7 }] };
    expect(AiAnalysisSchema.safeParse(badConfidence).success).toBe(false);
  });
  it("mock provider never invents numbers: statedValue is null unless the text stated one", () => {
    const stated = MOCK_ANALYSIS_JSON.candidate_variables.filter((c) => c.statedValue !== null);
    expect(stated).toHaveLength(1);
    expect(stated[0].statedValue).toBe(10000);
    expect(MOCK_ANALYSIS_JSON.candidate_variables.every((c) => c.evidence.length > 0)).toBe(true);
  });
  it("provider returns a validated analysis", async () => {
    const r = await new MockAiProvider().analyze({ text: "anything" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.analysis.candidate_variables.length).toBeGreaterThan(0);
  });
  it("system prompt carries the required stance", () => {
    for (const phrase of ["Separate observations from interpretations", "Do not moralize", "Do not assume motivation from leisure behavior", "Identify uncertainty explicitly"]) {
      expect(ANALYSIS_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
