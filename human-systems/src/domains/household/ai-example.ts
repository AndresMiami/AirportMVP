/**
 * Household domain: AI vocabulary fragment and a deterministic example
 * analysis (used by the mock provider for demos and tests). Household and
 * career words live here, never in the generic prompt.
 */
import type { PromptFragment } from "@/model/domain";

export const HOUSEHOLD_PROMPT_FRAGMENT: PromptFragment = {
  vocabulary:
    "This system is a person or a household: its usual variables are income sources and their reliability, essential and discretionary expenses, liquid reserves, debt payments, protected hours, career capital, physical capacity and schedule flexibility. Members are people; a variable may belong to one person or to the household as a whole.",
  examples:
    "Prefer wording such as \"income appears concentrated in one source\" or \"reserves cover about two months of essentials\"; never infer motivation from leisure, rest or appearance, and never describe a person's character.",
  questions: [
    "What is the monthly income, and what are the essential monthly expenses?",
    "How many months of essential expenses do liquid reserves cover?",
    "Which income sources would fail together?",
    "How many hours a week are genuinely free for something new?",
  ],
};

export const HOUSEHOLD_AI_EXAMPLE = {
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
  candidate_structural_dimensions: [
    {
      name: "Goal-directed saving capacity",
      rationale: "The text shows sustained accumulation toward a defined purchase; the default definition measures buffer size but not the capacity to accumulate deliberately.",
      suggestedContributingVariables: ["Saving discipline", "Capital conversion rate"],
      confidence: 0.5,
    },
  ],
  questions_to_reduce_uncertainty: [
    {
      question: "What is the monthly income, and what are the essential monthly expenses?",
      targetsDimension: "Reliable income floor",
      whyItMatters: "Without both, the floor ratio and buffer months cannot be computed at all.",
      expectedInformationGain: "high",
    },
    {
      question: "Is the four-day schedule chosen or imposed, and are the remaining days available for anything else?",
      targetsDimension: "Adaptive capacity",
      whyItMatters: "Free hours are unknown; rest time is being observed, not explained.",
      expectedInformationGain: "medium",
    },
  ],
};

