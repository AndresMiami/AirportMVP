/**
 * THE REAL PROVIDER, browser side (Step 7A). Implements the same
 * AiTaskProvider seam as the mock: it receives EXACTLY the provider payload
 * plus its contextHash, posts them to the same-origin reflection service
 * (a Netlify Function holding the provider key), and validates whatever
 * comes back with validateAiResponse against that same payload and hash.
 * Invalid output is a visible failure with nothing accepted; every failure
 * is a safe category sentence, never provider text. One attempt per call:
 * no retry loop. The transport is injectable so tests never touch the
 * network.
 */
import type { AiProviderPayload } from "./context";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, DEFAULT_ENDPOINT, REMOTE_LIMITS, RemoteResponseSchema, describeFailure, isRemoteEnabledTask, type RemoteFailureCategory } from "./remote-contract";
import { validateAiResponse, type AiResponseResult } from "./response";
import type { AiTaskProvider } from "./task-provider";

export interface RemoteTransportInput {
  url: string;
  body: string;
  signal: AbortSignal;
}
export interface RemoteTransportOutput {
  status: number;
  text: string;
}
export type RemoteTransport = (input: RemoteTransportInput) => Promise<RemoteTransportOutput>;

export interface RemoteProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  transport?: RemoteTransport;
}

/** The browser transport: same-origin POST with the client header; nothing else. */
export const fetchTransport: RemoteTransport = async ({ url, body, signal }) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [CLIENT_HEADER]: CLIENT_HEADER_VALUE }, body, credentials: "same-origin", signal });
  return { status: res.status, text: await res.text() };
};

export const REMOTE_ADAPTER_ID = "task-remote";

const fail = (category: RemoteFailureCategory, detail?: string): AiResponseResult => ({ ok: false, error: detail ? `${describeFailure(category)} (${detail})` : describeFailure(category) });

export class RemoteAiTaskProvider implements AiTaskProvider {
  readonly name = REMOTE_ADAPTER_ID;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly transport: RemoteTransport;
  constructor(options: RemoteProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? REMOTE_LIMITS.browserTimeoutMs;
    this.transport = options.transport ?? fetchTransport;
  }

  async run(payload: AiProviderPayload, contextHash: string): Promise<AiResponseResult> {
    if (!isRemoteEnabledTask(payload.task)) return fail("unsupported_task");
    const body = JSON.stringify({ version: 1, payload, contextHash });
    if (body.length > REMOTE_LIMITS.maxRequestBytes) return fail("too_large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let out: RemoteTransportOutput;
    try {
      out = await this.transport({ url: this.endpoint, body, signal: controller.signal });
    } catch (e) {
      return controller.signal.aborted || (e instanceof Error && e.name === "AbortError") ? fail("timeout") : fail("unreachable");
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = JSON.parse(out.text);
    } catch {
      return out.status === 200 ? fail("service_error") : fail("unreachable");
    }
    const wire = RemoteResponseSchema.safeParse(json);
    if (!wire.success) return fail("service_error");
    if (!wire.data.ok) return fail(wire.data.category);
    const v = validateAiResponse(wire.data.response, payload, contextHash);
    return v.ok ? v : fail("invalid_output", v.error);
  }
}
