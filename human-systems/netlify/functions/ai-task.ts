/**
 * THE REFLECTION SERVICE (Step 7A): the only place the provider key exists.
 * A Netlify Function on the Human Systems Lens site, served at
 * /api/ai-task next to the static export. It receives the browser's
 * envelope ({ version, payload, contextHash }), checks it against the
 * shared wire contract and recomputes the hash, sends the payload VERBATIM
 * to the provider with the task constitution and a fixed per-task JSON
 * schema, frames the provider's items into the response envelope, and
 * answers a category on every failure. It never logs a note, a context
 * item or a provider answer: the one log line carries task, category and
 * duration. No retries here or in the SDK; the browser decides whether to
 * try again. This file and the modules it imports use no "@/" alias.
 *
 * Environment (Netlify site settings, Functions scope):
 *   ANTHROPIC_API_KEY        required; absent -> not_configured
 *   HSL_AI_DISABLED=1        kill switch -> not_configured
 *   HSL_AI_MODEL             default claude-opus-5
 *   HSL_AI_EFFORT            low | medium | high (default low: latency and cost)
 *   HSL_AI_MAX_OUTPUT_TOKENS default REMOTE_LIMITS.maxOutputTokens
 *   HSL_AI_TIMEOUT_MS        default REMOTE_LIMITS.providerTimeoutMs
 *   HSL_AI_RATE_PER_10MIN    default REMOTE_LIMITS.ratePerTenMinutes
 */
import Anthropic from "@anthropic-ai/sdk";
import { canonical, contentHash } from "../../src/ai/hash";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, REMOTE_LIMITS, RemoteRequestSchema, TASK_PROVIDER_SYSTEM_PROMPT, outputSchemaFor, userMessageFor, type RemoteEnabledTask, type RemoteFailureCategory, type RemoteResponse } from "../../src/ai/remote-contract";

export const config = { path: "/api/ai-task" };

export interface ProviderCallInput {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  maxOutputTokens: number;
  timeoutMs: number;
  task: RemoteEnabledTask;
  userMessage: string;
}
export type ProviderOutcome = { ok: true; text: string; stopReason: string | null } | { ok: false; category: RemoteFailureCategory };
export type ProviderCall = (input: ProviderCallInput) => Promise<ProviderOutcome>;

/** Best-effort per-address limiter; state lives per function instance only. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs = 10 * 60_000) {}
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

export interface FunctionDeps {
  env: Record<string, string | undefined>;
  call?: ProviderCall;
  now?: () => number;
  limiter?: RateLimiter;
  /** Whitespace heartbeat interval while the provider works (keeps the response alive). */
  keepAliveMs?: number;
  log?: (line: string) => void;
}

/** Maps SDK errors to categories. Message text is never forwarded. */
export function categorizeProviderError(e: unknown): RemoteFailureCategory {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (e instanceof Anthropic.APIConnectionError) return "unreachable";
  if (e instanceof Anthropic.RateLimitError) return "rate_limited";
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return "not_configured";
  return "provider_error";
}

export const anthropicCall: ProviderCall = async (input) => {
  const client = new Anthropic({ apiKey: input.apiKey, timeout: input.timeoutMs, maxRetries: 0 });
  try {
    const message = await client.messages.create({
      model: input.model,
      max_tokens: input.maxOutputTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: input.effort, format: { type: "json_schema", schema: outputSchemaFor(input.task) } },
      system: TASK_PROVIDER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input.userMessage }],
    });
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { ok: true, text, stopReason: message.stop_reason };
  } catch (e) {
    return { ok: false, category: categorizeProviderError(e) };
  }
};

const intEnv = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const effortEnv = (raw: string | undefined): ProviderCallInput["effort"] => (raw === "medium" || raw === "high" ? raw : "low");

/** The instance's shared limiter, built from HSL_AI_RATE_PER_10MIN on first
 *  use; its state survives across requests and resets only if the
 *  configured rate changes (review finding, 2026-09-17: the setting was
 *  documented but never read). */
let sharedLimiter: { max: number; limiter: RateLimiter } | null = null;
function limiterFor(max: number): RateLimiter {
  if (!sharedLimiter || sharedLimiter.max !== max) sharedLimiter = { max, limiter: new RateLimiter(max) };
  return sharedLimiter.limiter;
}

const failure = (category: RemoteFailureCategory): RemoteResponse => ({ ok: false, category });

async function decide(req: Request, deps: FunctionDeps): Promise<{ body: RemoteResponse; status: number; task: string; work?: Promise<RemoteResponse> }> {
  const env = deps.env;
  const now = deps.now ?? Date.now;
  if (req.method !== "POST") return { body: failure("bad_request"), status: 405, task: "-" };
  const self = new URL(req.url).origin;
  const origin = req.headers.get("origin");
  if ((origin && origin !== self) || req.headers.get(CLIENT_HEADER) !== CLIENT_HEADER_VALUE) return { body: failure("bad_request"), status: 403, task: "-" };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.HSL_AI_DISABLED === "1") return { body: failure("not_configured"), status: 503, task: "-" };
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > REMOTE_LIMITS.maxRequestBytes) return { body: failure("too_large"), status: 413, task: "-" };
  const raw = await req.text();
  if (raw.length > REMOTE_LIMITS.maxRequestBytes) return { body: failure("too_large"), status: 413, task: "-" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { body: failure("bad_request"), status: 400, task: "-" };
  }
  const taskName = json && typeof json === "object" && "payload" in json && json.payload && typeof json.payload === "object" && "task" in json.payload ? String((json.payload as { task: unknown }).task) : "-";
  const parsed = RemoteRequestSchema.safeParse(json);
  if (!parsed.success) {
    const taskIssue = parsed.error.issues.some((i) => i.path.join(".") === "payload.task");
    return { body: failure(taskIssue ? "unsupported_task" : "bad_request"), status: 400, task: taskName };
  }
  const { payload, contextHash } = parsed.data;
  if (contentHash(canonical(payload)) !== contextHash) return { body: failure("bad_request"), status: 400, task: payload.task };
  const limiter = deps.limiter ?? limiterFor(intEnv(env.HSL_AI_RATE_PER_10MIN, REMOTE_LIMITS.ratePerTenMinutes));
  const address = req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!limiter.allow(address, now())) return { body: failure("rate_limited"), status: 429, task: payload.task };
  const call = deps.call ?? anthropicCall;
  const work = call({
    apiKey,
    model: env.HSL_AI_MODEL?.trim() || "claude-opus-5",
    effort: effortEnv(env.HSL_AI_EFFORT),
    maxOutputTokens: intEnv(env.HSL_AI_MAX_OUTPUT_TOKENS, REMOTE_LIMITS.maxOutputTokens),
    timeoutMs: intEnv(env.HSL_AI_TIMEOUT_MS, REMOTE_LIMITS.providerTimeoutMs),
    task: payload.task,
    userMessage: userMessageFor(payload),
  }).then((outcome): RemoteResponse => {
    if (!outcome.ok) return failure(outcome.category);
    if (outcome.stopReason === "refusal") return failure("refused");
    if (outcome.stopReason === "max_tokens") return failure("output_truncated");
    let out: unknown;
    try {
      out = JSON.parse(outcome.text);
    } catch {
      return failure("invalid_output");
    }
    if (!out || typeof out !== "object" || !Array.isArray((out as { items?: unknown }).items)) return failure("invalid_output");
    return { ok: true, response: { version: 1, task: payload.task, contextHash, items: (out as { items: unknown[] }).items } };
  }, () => failure("provider_error"));
  return { body: failure("service_error"), status: 200, task: payload.task, work };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };

export async function handleAiTask(req: Request, deps: FunctionDeps): Promise<Response> {
  const started = (deps.now ?? Date.now)();
  const log = deps.log ?? ((line: string) => console.log(line));
  const finish = (task: string, body: RemoteResponse) => log(JSON.stringify({ event: "ai-task", task, outcome: body.ok ? "ok" : body.category, ms: (deps.now ?? Date.now)() - started }));
  let decision: Awaited<ReturnType<typeof decide>>;
  try {
    decision = await decide(req, deps);
  } catch {
    const body = failure("service_error");
    finish("-", body);
    return new Response(JSON.stringify(body), { status: 500, headers: JSON_HEADERS });
  }
  if (!decision.work) {
    finish(decision.task, decision.body);
    return new Response(JSON.stringify(decision.body), { status: decision.status, headers: JSON_HEADERS });
  }
  // The provider takes seconds; a whitespace heartbeat keeps the connection
  // open and the body stays valid JSON (leading whitespace is permitted).
  const work = decision.work;
  const keepAliveMs = deps.keepAliveMs ?? 2500;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = setInterval(() => controller.enqueue(encoder.encode(" ")), keepAliveMs);
      void work.then((body) => {
        clearInterval(beat);
        finish(decision.task, body);
        controller.enqueue(encoder.encode(JSON.stringify(body)));
        controller.close();
      });
    },
  });
  return new Response(stream, { status: 200, headers: JSON_HEADERS });
}

const handler = (req: Request): Promise<Response> => handleAiTask(req, { env: process.env });
export default handler;
