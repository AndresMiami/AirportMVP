/**
 * The one-time boundary acknowledgement lives in this browser only: it is
 * a per-viewer convenience, not model state, and it never travels. Reads
 * and writes are guarded; without storage the disclosure simply shows
 * again next time.
 */
export const CONSENT_KEY = "human-systems.ai-consent.v1";

export function readConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "acknowledged";
  } catch {
    return false;
  }
}
export function writeConsent(): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, "acknowledged");
  } catch {
    /* storage unavailable: the disclosure shows again next time */
  }
}
