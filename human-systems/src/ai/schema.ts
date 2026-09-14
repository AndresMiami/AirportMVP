/**
 * Strict schema for what an AI provider may return. Anything the model
 * emits outside this shape is rejected at the boundary. Nothing in this
 * file ever writes to the SystemModel: candidates go to a review screen
 * where the person approves, edits, or rejects each one.
 */
import { z } from "zod";
import {
  ChangeSpeedSchema,
  EdgeDirectionSchema,
  LagSchema,
  VariableCategorySchema,
} from "@/types";

const unitInterval = z.number().min(0).max(1);

export const ObservationSchema = z.object({
  text: z.string().min(1),
  /** Verbatim or near-verbatim support from the input. */
  quote: z.string().optional(),
});

export const CandidateVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  category: VariableCategorySchema,
  changeSpeed: ChangeSpeedSchema,
  /** Qualitative reading, e.g. "likely high". Never a number invented by the AI. */
  qualitativeValue: z.string().min(1),
  /** A number is allowed ONLY when the input stated it (measured/self-reported). */
  statedValue: z.number().nullable().default(null),
  unit: z.string().default(""),
  evidence: z.string().min(1),
  confidence: unitInterval,
  /** Why this might be wrong. */
  caveat: z.string().default(""),
});

export const CandidateRelationshipSchema = z.object({
  sourceVariable: z.string().min(1),
  targetVariable: z.string().min(1),
  direction: EdgeDirectionSchema,
  strengthEstimate: unitInterval,
  lagEstimate: LagSchema.default({ value: 0, unit: "months" }),
  explanation: z.string().min(1),
  confidence: unitInterval,
});

export const CandidateConstraintSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
  confidence: unitInterval,
});

export const CandidateLoopSchema = z.object({
  variableNames: z.array(z.string().min(1)).min(2),
  polarity: z.enum(["reinforcing", "balancing"]),
  explanation: z.string().min(1),
  confidence: unitInterval,
});

/** A dimension the AI thinks the signature definition is missing for
 *  this system. It is a PROPOSAL for the person and the definition
 *  author; the engine never adds dimensions on its own. */
export const CandidateStructuralDimensionSchema = z.object({
  name: z.string().min(1),
  rationale: z.string().min(1),
  /** Names of variables (existing or candidate) that would feed it. */
  suggestedContributingVariables: z.array(z.string()).default([]),
  confidence: unitInterval,
});

/** A question whose answer would most reduce uncertainty. The AI ranks
 *  by its own judgment; the deterministic question-priority heuristic
 *  (signatures/questions.ts) is the one the app orders by. */
export const UncertaintyQuestionSchema = z.object({
  question: z.string().min(1),
  targetsVariable: z.string().optional(),
  targetsDimension: z.string().optional(),
  whyItMatters: z.string().min(1),
  expectedInformationGain: z.enum(["low", "medium", "high"]),
});

/**
 * STRICT: unknown keys are rejected, so a provider that tries to return a
 * structural signature, a score, or any other verdict fails validation.
 * AI interprets; evidence constrains; the model calculates; the human
 * approves.
 */
export const AiAnalysisSchema = z
  .object({
    observations: z.array(ObservationSchema),
    candidate_variables: z.array(CandidateVariableSchema),
    candidate_relationships: z.array(CandidateRelationshipSchema),
    candidate_constraints: z.array(CandidateConstraintSchema),
    possible_feedback_loops: z.array(CandidateLoopSchema),
    missing_information: z.array(z.string()),
    contradictions: z.array(z.string()),
    confidence_notes: z.array(z.string()),
    candidate_structural_dimensions: z.array(CandidateStructuralDimensionSchema).default([]),
    questions_to_reduce_uncertainty: z.array(UncertaintyQuestionSchema).default([]),
  })
  .strict();
export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;

export type ParseResult =
  | { ok: true; analysis: AiAnalysis }
  | { ok: false; error: string };

/** Parse raw provider text as strict JSON, then validate. */
export function parseAiAnalysis(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (e) {
    return { ok: false, error: `Response was not valid JSON: ${(e as Error).message}` };
  }
  const result = AiAnalysisSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: `Response did not match the analysis schema: ${result.error.message}` };
  }
  return { ok: true, analysis: result.data };
}

function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : trimmed;
}
