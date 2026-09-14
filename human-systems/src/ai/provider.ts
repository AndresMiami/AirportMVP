/**
 * Provider abstraction. The application only ever talks to this interface,
 * so swapping Anthropic / OpenAI / a local model is a one-file change.
 * Providers return the parsed, validated analysis or a typed failure.
 */
import type { AiAnalysis, ParseResult } from "./schema";

export interface AnalysisRequest {
  /** The person's natural-language description. */
  text: string;
  /** Optional context, e.g. the names of variables already in the model. */
  existingVariableNames?: string[];
}

export interface AiProvider {
  readonly name: string;
  analyze(request: AnalysisRequest): Promise<ParseResult>;
}

export type { AiAnalysis };
