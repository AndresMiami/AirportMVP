/**
 * AI SURFACE WORDING (Step 7A). Pure. Everything Home and Explore say
 * about a reflection lives here, so the pages carry no epistemic enum
 * names, no hashes and no schema terms: the boundary is explained in
 * plain words, failures are one calm line, and the epistemic states are
 * translated, never mapped to numbers.
 */
import type { AiContextManifest, ContextItem, ContextItemKind, EpistemicState } from "@/ai/context";
import type { AiProviderKind } from "@/ai/task-select";

export const REFLECTION_FAILED = "Reflection couldn't be completed. Try again.";
export const THINKING_FAILED = "Suggestions couldn't be completed. Try again.";

/** The boundary sentence before the first external call. */
export const DISCLOSURE_NOTE = "AI reflection sends this note and the relevant notebook context to the AI provider.";
export const DISCLOSURE_PATTERN = "Help me think sends this pattern and the relevant notebook context to the AI provider.";
export const DISCLOSURE_TAIL = "Sensitive items stay out unless you include them in AI diagnostics. Nothing is saved to your notebook, and the provider cannot change it.";
export const NOTHING_SAVED = "Nothing is saved to your notebook.";
export const DEMO_CAPTION = "Demo response · nothing is saved to your notebook.";

/** Whether the boundary must be shown before this call runs. */
export const needsDisclosure = (kind: AiProviderKind, acknowledged: boolean): boolean => kind === "remote" && !acknowledged;

export const providerBadge = (kind: AiProviderKind): string | null => (kind === "mock" ? "Demo" : null);
export const responseHeading = (kind: AiProviderKind): string => (kind === "mock" ? "Demo response" : "Reflection");

const KIND_WORDS: Record<ContextItemKind, [one: string, many: string]> = {
  system: ["the system description", "the system descriptions"],
  variable: ["1 recorded condition", "recorded conditions"],
  value: ["1 recorded value", "recorded values"],
  variable_history: ["1 value history", "value histories"],
  derived: ["1 calculated value", "calculated values"],
  observation: ["1 observation", "observations"],
  event: ["1 event", "events"],
  relationship: ["1 connection", "connections"],
  constraint: ["1 constraint", "constraints"],
  hypothesis: ["1 working explanation", "working explanations"],
  pattern: ["the pattern", "the patterns"],
  cross_context: ["the occurrence and contrast comparison", "the comparisons"],
  catalogue_prompt: ["1 explanation prompt", "explanation prompts"],
  user_text: ["your note", "your notes"],
};
const ORDER: ContextItemKind[] = ["user_text", "pattern", "cross_context", "system", "variable", "value", "derived", "variable_history", "observation", "event", "relationship", "constraint", "hypothesis", "catalogue_prompt"];

/** Plain lines saying what leaves the browser, from the LOCAL manifest (never sent itself). */
export function sharedLines(manifest: AiContextManifest): string[] {
  const lines: string[] = [];
  for (const kind of ORDER) {
    const n = manifest.included[kind] ?? 0;
    if (n === 0) continue;
    const [one, many] = KIND_WORDS[kind];
    lines.push(n === 1 ? one : kind === "system" || kind === "pattern" || kind === "cross_context" || kind === "user_text" ? many : `${n} ${many}`);
  }
  if (manifest.sensitiveExcluded.length > 0) lines.push(manifest.sensitiveExcluded.length === 1 ? "1 sensitive item is left out" : `${manifest.sensitiveExcluded.length} sensitive items are left out`);
  return lines;
}

/** Epistemic states in words. Never a number. */
export const STATE_WORDS: Record<Exclude<EpistemicState, "directly_stated">, string> = {
  interpretive: "A reading of what the records say",
  tentative: "Tentative: not directly supported by the records",
  unresolved: "Can't be told from the records",
};
export const stateWords = (state: EpistemicState): string => (state === "directly_stated" ? "Stated in the records" : STATE_WORDS[state]);

const short = (s: string, max = 90) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** A cited context item in human words (for "rests on"). */
export function citedLabel(item: ContextItem): string {
  const p = item.payload as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  switch (item.kind) {
    case "pattern":
      return "the pattern";
    case "cross_context":
      return "the occurrence and contrast comparison";
    case "observation":
      return `an observation: “${short(str("statement"))}”`;
    case "event":
      return `an event: ${short(str("title"))}`;
    case "catalogue_prompt":
      return `an explanation prompt: ${short(str("question"))}`;
    case "user_text":
      return "your note";
    case "system":
      return "the system description";
    case "value":
    case "derived":
      return `the recorded value of ${str("variable") || "a condition"}`;
    case "variable":
      return `the condition ${str("name")}`.trim();
    case "hypothesis":
      return `a working explanation: “${short(str("statement"))}”`;
    default:
      return item.kind.replace(/_/g, " ");
  }
}

export const citedLabels = (refs: readonly string[], items: readonly ContextItem[]): string[] => {
  const byId = new Map(items.map((i) => [i.id, i]));
  return [...new Set(refs.map((r) => (byId.get(r) ? citedLabel(byId.get(r)!) : null)).filter((x): x is string => x !== null))];
};
