/**
 * EXPLORE "HELP ME THINK" BINDING (Step 7A): the same contextHash binding
 * Home uses (6A.1.1), for the pattern task. The context is
 * suggest_explanations_for_pattern over the exact PatternRef Explore
 * shows; a stored answer is visible only while its hash still matches the
 * current model and pattern. Nothing here runs a provider.
 */
import { AiContextError, buildAiContext, type AiContext } from "@/ai/context";
import type { AiResponse } from "@/ai/response";
import type { PatternRef } from "@/discovery/cross-context";
import type { SystemModel } from "@/types";

export type ThinkingResult = { ok: true; response: AiResponse } | { ok: false; error: string };

export interface ExploreThinking {
  forHash: string;
  result: ThinkingResult;
}

export type ExploreContext = { ctx: AiContext } | { error: string };

export function exploreContext(model: SystemModel, pattern: PatternRef): ExploreContext {
  try {
    return { ctx: buildAiContext(model, "suggest_explanations_for_pattern", { pattern }) };
  } catch (e) {
    return { error: e instanceof AiContextError ? e.message : e instanceof Error ? e.message : String(e) };
  }
}

export function visibleThinking(thinking: ExploreThinking | null, current: ExploreContext | null): ThinkingResult | null {
  if (!thinking || !current || !("ctx" in current)) return null;
  return thinking.forHash === current.ctx.contextHash ? thinking.result : null;
}
