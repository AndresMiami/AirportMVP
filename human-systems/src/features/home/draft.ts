/**
 * The Home draft is a per-viewer convenience in this browser, never model
 * state. Moved out of the page in Step 7A so the AI diagnostics screen can
 * show the exact payload for the SAME note (?source=home-draft) without the
 * note travelling in a URL.
 */
export const DRAFT_KEY = "human-systems.home-draft.v1";

export function readDraft(modelId: string): string {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, string>;
    return typeof all[modelId] === "string" ? all[modelId] : "";
  } catch {
    return "";
  }
}
export function writeDraft(modelId: string, text: string): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, string>;
    all[modelId] = text;
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the draft lives for this page only */
  }
}
