/**
 * The task-provider seam (Step 5C). A provider receives EXACTLY the
 * provider payload plus the contextHash that identifies it, and returns a
 * response the caller validates against that same payload. No network
 * implementation exists yet; the legacy AiProvider stays beside this for
 * the read-only legacy display only.
 */
import type { AiProviderPayload } from "./context";
import type { AiResponseResult } from "./response";

export interface AiTaskProvider {
  readonly name: string;
  run(payload: AiProviderPayload, contextHash: string): Promise<AiResponseResult>;
}
