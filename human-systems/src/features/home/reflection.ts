/**
 * HOME REFLECTION BINDING (Step 6A.1.1): the demo reflection belongs to
 * the exact AI context that produced it — the same contextHash identity
 * the technical /ai screen uses. Home recomputes the context from the
 * current model, draft and as-of selection and shows a stored reflection
 * only while its hash still matches. Nothing here reruns the provider.
 * Pure; no React; no household.
 */
import { AiContextError, buildAiContext, type AiContext } from "@/ai/context";
import type { AiOutputItem } from "@/ai/response";
import type { SystemModel } from "@/types";

export type ReflectionResult = { ok: true; items: AiOutputItem[] } | { ok: false; error: string };

export interface HomeReflection {
  /** contextHash of the provider payload the result answered. */
  forHash: string;
  result: ReflectionResult;
}

export type HomeContext = { ctx: AiContext } | { error: string } | null;

/**
 * The provider-visible context for the Home draft: interpret_free_text
 * over the system subject, values as of the selected date (or today).
 * null when there is no text; a builder refusal is returned as its
 * message, never thrown into rendering.
 */
export function homeContext(model: SystemModel, draft: string, asOf: string | null, today: string): HomeContext {
  if (draft.trim().length === 0) return null;
  try {
    return { ctx: buildAiContext(model, "interpret_free_text", { subjectId: model.id, userText: draft, asOf: (asOf ?? today).slice(0, 10) }) };
  } catch (e) {
    return { error: e instanceof AiContextError ? e.message : e instanceof Error ? e.message : String(e) };
  }
}

/** The stored reflection, only while the current context is the one it answered. */
export function visibleReflection(reflection: HomeReflection | null, current: HomeContext): ReflectionResult | null {
  if (!reflection || !current || !("ctx" in current)) return null;
  return reflection.forHash === current.ctx.contextHash ? reflection.result : null;
}
