/**
 * PROVIDER SELECTION (Step 7A): explicit and build-time. The browser bundle
 * carries ONE non-secret flag, NEXT_PUBLIC_AI_PROVIDER, inlined by Next at
 * build: "remote" selects the reflection service; anything else (unset
 * included) selects the deterministic mock, so tests, local builds and an
 * unconfigured site never make a paid call. No key ever lives here.
 */
import { MockAiTaskProvider } from "./task-mock";
import type { AiTaskProvider } from "./task-provider";
import { REMOTE_ADAPTER_ID, RemoteAiTaskProvider, type RemoteProviderOptions } from "./task-remote";

export type AiProviderKind = "mock" | "remote";

export function providerKindFrom(raw: string | undefined | null): AiProviderKind {
  return raw?.trim().toLowerCase() === "remote" ? "remote" : "mock";
}

/** Inlined at build; the ONLY environment value the browser bundle reads. */
export const CONFIGURED_PROVIDER_KIND: AiProviderKind = providerKindFrom(process.env.NEXT_PUBLIC_AI_PROVIDER);

/** The adapterId recorded as the ORIGIN of an AI-derived proposal. */
export const ADAPTER_IDS: Record<AiProviderKind, string> = { mock: "task-mock", remote: REMOTE_ADAPTER_ID };

export function createTaskProvider(kind: AiProviderKind, options: RemoteProviderOptions = {}): AiTaskProvider {
  return kind === "remote" ? new RemoteAiTaskProvider(options) : new MockAiTaskProvider();
}
