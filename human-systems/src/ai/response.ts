/**
 * STRICT AI OUTPUT CONTRACT (Step 5C). What a task provider may return,
 * validated against the exact provider payload it received:
 *
 *   - unknown keys rejected; contextHash must equal the supplied one;
 *   - every cited reference must be an item id in the payload (typed
 *     items, never fuzzy names);
 *   - an Extraction's quote must occur VERBATIM in its cited textual source
 *     and its state is always directly_stated (= the source says it; NOT
 *     that it is true);
 *   - Interpretations and CandidateExplanations may never claim
 *     directly_stated; their text may not assert cause, proof or odds;
 *   - output kinds are fixed per task;
 *   - NO numeric epistemics anywhere: no confidence, probability, odds,
 *     strength, lag or information-gain fields; the epistemic states are
 *     words and are never mapped to numbers.
 * One invalid citation or claim rejects the WHOLE response. No salvage.
 */
import { z } from "zod";
import { containsForbiddenPhrase } from "@/discovery/language";
import { AI_TASKS, EPISTEMIC_STATES, type AiProviderPayload, type AiTask, type ContextItem } from "./context";

const nonEmpty = z.string().min(1);
const refs = z.array(nonEmpty).min(1);

export const ExtractionSchema = z
  .object({
    kind: z.literal("extraction"),
    id: nonEmpty,
    text: nonEmpty,
    /** Exact substring of the cited textual source. */
    quote: nonEmpty,
    sourceRef: nonEmpty,
    subjectRef: nonEmpty.optional(),
    state: z.literal("directly_stated"),
  })
  .strict();

export const InterpretationSchema = z
  .object({
    kind: z.literal("interpretation"),
    id: nonEmpty,
    text: nonEmpty,
    restsOn: refs,
    state: z.enum(["interpretive", "tentative", "unresolved"]),
    caveat: z.string().default(""),
  })
  .strict();

export const CandidateExplanationSchema = z
  .object({
    kind: z.literal("candidate_explanation"),
    id: nonEmpty,
    text: nonEmpty,
    forPattern: nonEmpty,
    restsOn: refs,
    state: z.enum(["interpretive", "tentative", "unresolved"]),
    weakenedBy: z.array(nonEmpty).default([]),
    alternatives: z.array(nonEmpty).default([]),
  })
  .strict();

export const QuestionSchema = z
  .object({
    kind: z.literal("question"),
    id: nonEmpty,
    text: nonEmpty,
    targets: z.array(nonEmpty).default([]),
    whyItMatters: nonEmpty,
  })
  .strict();

export const SummarySchema = z
  .object({
    kind: z.literal("summary"),
    id: nonEmpty,
    sections: z.array(z.object({ heading: nonEmpty, text: nonEmpty, cites: refs }).strict()).min(1),
  })
  .strict();

export const AiOutputItemSchema = z.discriminatedUnion("kind", [ExtractionSchema, InterpretationSchema, CandidateExplanationSchema, QuestionSchema, SummarySchema]);
export type AiOutputItem = z.infer<typeof AiOutputItemSchema>;
export type AiOutputKind = AiOutputItem["kind"];

export const AiResponseSchema = z
  .object({
    version: z.literal(1),
    task: z.enum(AI_TASKS),
    contextHash: nonEmpty,
    items: z.array(AiOutputItemSchema),
  })
  .strict();
export type AiResponse = z.infer<typeof AiResponseSchema>;

/** Output kinds each task may return. Anything else rejects the response. */
export const TASK_OUTPUT_KINDS: Record<AiTask, readonly AiOutputKind[]> = {
  extract_statements: ["extraction"],
  propose_observation_from_user_statement: ["extraction"],
  interpret_free_text: ["interpretation", "question"],
  suggest_explanations_for_pattern: ["candidate_explanation", "question"],
  suggest_questions_to_reduce_uncertainty: ["question"],
  summarize_model: ["summary"],
};

/** Claims an interpretation may never make (beyond the discovery guard). Ordinary conditional language (may, might, could, one possibility) is fine. */
export const FORBIDDEN_CLAIMS = ["this caused", "caused by", "this proves", "proves that", "the real reason", "% likely", "percent likely", "will happen", "definitely", "certainly", "is the cause", "the cause of", "must be the cause"] as const;

export function forbiddenClaim(text: string): string | null {
  const lower = text.toLowerCase();
  for (const c of FORBIDDEN_CLAIMS) if (lower.includes(c)) return c;
  if (/\b\d{1,3}\s?%\s*(likely|chance|probab)/i.test(text) || /\bprobability of\b/i.test(text)) return "a probability claim";
  return containsForbiddenPhrase(text);
}

/** Item kinds whose payload carries person-authored text a quote may come from. */
const TEXT_FIELD: Partial<Record<ContextItem["kind"], string>> = { user_text: "text", observation: "statement", hypothesis: "statement", event: "title" };

export type AiResponseResult = { ok: true; response: AiResponse } | { ok: false; error: string };

function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : trimmed;
}

/**
 * Validate a raw response (text or parsed) against the exact payload the
 * provider received and the contextHash that identifies it.
 */
export function validateAiResponse(raw: unknown, payload: AiProviderPayload, contextHash: string): AiResponseResult {
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(stripCodeFence(raw));
    } catch (e) {
      return { ok: false, error: `Response was not valid JSON: ${(e as Error).message}` };
    }
  }
  const parsed = AiResponseSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `Response did not match the contract: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  const r = parsed.data;
  if (r.task !== payload.task) return { ok: false, error: `Response is for task ${r.task}; the payload was for ${payload.task}` };
  if (r.contextHash !== contextHash) return { ok: false, error: "Response cites a different context (contextHash mismatch); nothing is accepted" };
  const allowed = TASK_OUTPUT_KINDS[payload.task];
  const byId = new Map(payload.items.map((it) => [it.id, it]));
  const seen = new Set<string>();
  const exists = (ref: string, role: string, itemId: string) => (byId.has(ref) ? null : `${itemId}: ${role} "${ref}" is not in the supplied context`);
  for (const it of r.items) {
    if (seen.has(it.id)) return { ok: false, error: `Duplicate output item id "${it.id}"` };
    seen.add(it.id);
    if (!allowed.includes(it.kind)) return { ok: false, error: `${it.id}: output kind "${it.kind}" is not allowed for task ${payload.task}` };
    switch (it.kind) {
      case "extraction": {
        const bad = exists(it.sourceRef, "sourceRef", it.id) ?? (it.subjectRef ? exists(it.subjectRef, "subjectRef", it.id) : null);
        if (bad) return { ok: false, error: bad };
        const src = byId.get(it.sourceRef)!;
        const field = TEXT_FIELD[src.kind];
        const text = field ? src.payload[field] : undefined;
        if (typeof text !== "string") return { ok: false, error: `${it.id}: sourceRef "${it.sourceRef}" is not a textual source` };
        if (!text.includes(it.quote)) return { ok: false, error: `${it.id}: quote is not a verbatim substring of ${it.sourceRef}` };
        break;
      }
      case "interpretation": {
        for (const ref of it.restsOn) {
          const bad = exists(ref, "restsOn", it.id);
          if (bad) return { ok: false, error: bad };
        }
        const claim = forbiddenClaim(it.text);
        if (claim) return { ok: false, error: `${it.id}: an interpretation may not claim "${claim}"` };
        break;
      }
      case "candidate_explanation": {
        const pat = byId.get(it.forPattern);
        if (!pat || pat.kind !== "pattern") return { ok: false, error: `${it.id}: forPattern "${it.forPattern}" is not a pattern item in the supplied context` };
        for (const ref of it.restsOn) {
          const bad = exists(ref, "restsOn", it.id);
          if (bad) return { ok: false, error: bad };
        }
        for (const t of [it.text, ...it.weakenedBy, ...it.alternatives]) {
          const claim = forbiddenClaim(t);
          if (claim) return { ok: false, error: `${it.id}: a candidate explanation may not claim "${claim}"` };
        }
        break;
      }
      case "question": {
        for (const ref of it.targets) {
          const bad = exists(ref, "target", it.id);
          if (bad) return { ok: false, error: bad };
        }
        break;
      }
      case "summary": {
        for (const s of it.sections) {
          for (const ref of s.cites) {
            const bad = exists(ref, "cite", it.id);
            if (bad) return { ok: false, error: bad };
          }
          const claim = forbiddenClaim(s.text);
          if (claim) return { ok: false, error: `${it.id}: a summary may not claim "${claim}"` };
        }
        break;
      }
    }
  }
  return { ok: true, response: r };
}

/** Field names the contract must never contain (pinned by test). */
export const NUMERIC_EPISTEMIC_FIELDS = ["confidence", "probability", "odds", "strengthEstimate", "lagEstimate", "expectedInformationGain", "score", "likelihood"] as const;
export { EPISTEMIC_STATES };
