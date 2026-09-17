/**
 * THE WIRE CONTRACT between the browser and the reflection service
 * (Step 7A). Shared by the RemoteAiTaskProvider (browser) and the Netlify
 * Function (server), so both sides validate the same shapes. This module
 * uses NO "@/" alias and imports only types from the app, because the
 * server bundle is built outside Next.
 *
 *   browser -> server:  { version: 1, payload: <exactly providerPayload(ctx)>, contextHash }
 *   server  -> provider: system prompt + the payload JSON, verbatim
 *   provider -> server: { items: [...] } (a fixed per-task JSON schema)
 *   server  -> browser: { ok: true, response: { version, task, contextHash, items } }
 *                    or { ok: false, category }
 *
 * The server FRAMES the envelope (version, task, contextHash) from the
 * request it received; the provider writes only items. The browser then
 * runs validateAiResponse against ITS payload and hash, so nothing the
 * server says is trusted for the contract. Failures are categories from a
 * fixed table: never raw provider text, never stack traces.
 */
import { z } from "zod";
import type { AiProviderPayload, AiTask } from "./context";

/** The only tasks the reflection service answers. Extraction and summary stay mock/diagnostic. */
export const REMOTE_ENABLED_TASKS = ["interpret_free_text", "suggest_explanations_for_pattern", "suggest_questions_to_reduce_uncertainty"] as const;
export type RemoteEnabledTask = (typeof REMOTE_ENABLED_TASKS)[number];
export const isRemoteEnabledTask = (task: AiTask): task is RemoteEnabledTask => (REMOTE_ENABLED_TASKS as readonly string[]).includes(task);

export const REMOTE_LIMITS = {
  /** Serialized request bytes the service accepts. */
  maxRequestBytes: 200_000,
  /** Context items per request. */
  maxItems: 400,
  /** Provider output tokens (default; HSL_AI_MAX_OUTPUT_TOKENS overrides on the server). */
  maxOutputTokens: 1500,
  /** Server-side wait for the provider (default; HSL_AI_TIMEOUT_MS overrides). */
  providerTimeoutMs: 25_000,
  /** Browser-side wait for the service. */
  browserTimeoutMs: 40_000,
  /** Calls per client address per ten minutes (default; HSL_AI_RATE_PER_10MIN overrides). Best effort, per instance. */
  ratePerTenMinutes: 20,
} as const;

/** Request header the browser sets; a cross-origin page cannot send it without a preflight the service never grants. */
export const CLIENT_HEADER = "x-hsl-client";
export const CLIENT_HEADER_VALUE = "lens";
export const DEFAULT_ENDPOINT = "/api/ai-task";

const ContextItemWire = z
  .object({
    ref: z.unknown(),
    id: z.string().min(1),
    kind: z.string().min(1),
    subjectId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const RemoteRequestSchema = z
  .object({
    version: z.literal(1),
    payload: z
      .object({
        version: z.literal(1),
        task: z.enum(REMOTE_ENABLED_TASKS),
        items: z.array(ContextItemWire).max(REMOTE_LIMITS.maxItems),
      })
      .strict(),
    contextHash: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();
export type RemoteRequest = z.infer<typeof RemoteRequestSchema>;

export const FAILURE_CATEGORIES = ["not_configured", "bad_request", "unsupported_task", "too_large", "rate_limited", "timeout", "unreachable", "service_error", "provider_error", "refused", "output_truncated", "invalid_output"] as const;
export type RemoteFailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Safe words for each category: no provider text, no identifiers, no advice beyond "try again". */
export const FAILURE_WORDS: Record<RemoteFailureCategory, string> = {
  not_configured: "The AI provider is not set up for this site.",
  bad_request: "The request was not in the form the reflection service expects.",
  unsupported_task: "This kind of request is not sent to the AI provider.",
  too_large: "The note and context are too large to send.",
  rate_limited: "Too many requests in a short time. Wait a little before trying again.",
  timeout: "The AI provider did not answer in time.",
  unreachable: "The reflection service could not be reached.",
  service_error: "The reflection service answered in an unexpected way.",
  provider_error: "The AI provider returned an error.",
  refused: "The AI provider declined to answer this note.",
  output_truncated: "The AI provider's answer was cut short.",
  invalid_output: "The AI provider's answer did not meet the contract, so none of it is shown.",
};
export const describeFailure = (category: RemoteFailureCategory): string => FAILURE_WORDS[category];

export const RemoteResponseSchema = z.union([
  z.object({ ok: z.literal(true), response: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), category: z.enum(FAILURE_CATEGORIES) }).strict(),
]);
export type RemoteResponse = z.infer<typeof RemoteResponseSchema>;

/* ------------------------------------------------------------------ */
/* What the provider is told                                           */
/* ------------------------------------------------------------------ */

/** The constitution for the task contract (5C). Domain-neutral; the payload is the only context. */
export const TASK_PROVIDER_SYSTEM_PROMPT = `You are the reflection assistant inside a personal notebook for thinking about a system of any kind over time. You receive ONE JSON payload: a task name and a list of typed context items, each with an id. Nothing else exists for this call: no memory, no outside facts, no assumptions about the kind of system beyond what the items say.

Epistemic rules. They are the product; keep them over helpfulness.
- Cite only item ids that appear in the payload. Every restsOn, targets and forPattern entry must be one of those ids, copied exactly. Never invent an id.
- A value item carries a basis: recorded_here, carried_forward, calculated, explicit_unknown, ambiguous or unknown. Unknown is not zero and not absence. Carried forward is not a fresh reading. Say what the basis allows and no more.
- Never assert cause, proof, likelihood, odds or percentages. Never write "this caused", "caused by", "proves", "the real reason", "definitely", "certainly", "will happen", "the cause of" or "must be the cause". Use "one possibility", "may", "might", "could", "appears".
- Never diagnose, label or type a person; describe conditions of the situation. Never moralize. Never prescribe: no "you should", "you must", "the right choice". The person decides.
- Stored judgments in the items (confidence, strength, status) are a person's own ordinal entries, not measurements and not facts.
- Epistemic states: interpretive means a reading of what the items say; tentative means a reading without direct support in the items; unresolved means it cannot be told from the items. Interpretations and candidate explanations are never directly_stated.
- Prefer few, careful items over many. An empty items array is allowed when the payload supports nothing.

Voice: calm, plain, conversational, second person where natural. No jargon, no lists inside text fields, and no mention of ids, hashes, schemas, tokens or "the payload" inside text fields (ids belong only in the citation fields). Do not restate the whole note back.

Task interpret_free_text: return one to three interpretation items that read the person's note (the user_text item) against the supplied context, each with a caveat saying what it rests on and what it does not, then zero to two question items the person could answer next, each with whyItMatters.
Task suggest_explanations_for_pattern: return one to three candidate_explanation items for the pattern item (forPattern is its id), each grounded in the cross_context comparison, observations or events supplied (restsOn), with weakenedBy (evidence that would weaken it) and alternatives (other readings), then zero to two question items.
Task suggest_questions_to_reduce_uncertainty: return up to three question items whose answers would change the reading most, each targeting the items it concerns.

Output: only the JSON the schema describes.`;

/** The user message is the payload, verbatim: exactly what the browser previewed and hashed. */
export const userMessageFor = (payload: Pick<AiProviderPayload, "version" | "task"> & { items: unknown[] }): string => JSON.stringify(payload);

const STR = { type: "string" } as const;
const STRS = { type: "array", items: STR } as const;
const STATE = { type: "string", enum: ["interpretive", "tentative", "unresolved"] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const OUTPUT_KIND_SCHEMAS = {
  interpretation: obj({ kind: { type: "string", const: "interpretation" }, id: STR, text: STR, restsOn: STRS, state: STATE, caveat: STR }),
  candidate_explanation: obj({ kind: { type: "string", const: "candidate_explanation" }, id: STR, text: STR, forPattern: STR, restsOn: STRS, state: STATE, weakenedBy: STRS, alternatives: STRS }),
  question: obj({ kind: { type: "string", const: "question" }, id: STR, text: STR, targets: STRS, whyItMatters: STR }),
} as const;

const TASK_KINDS: Record<RemoteEnabledTask, readonly (keyof typeof OUTPUT_KIND_SCHEMAS)[]> = {
  interpret_free_text: ["interpretation", "question"],
  suggest_explanations_for_pattern: ["candidate_explanation", "question"],
  suggest_questions_to_reduce_uncertainty: ["question"],
};

/** A fixed JSON schema per task (cacheable by the provider): items only; the server frames the envelope. */
export function outputSchemaFor(task: RemoteEnabledTask): Record<string, unknown> {
  return obj({ items: { type: "array", items: { anyOf: TASK_KINDS[task].map((k) => OUTPUT_KIND_SCHEMAS[k]) } } });
}
