/**
 * Deterministic task mock for the NEW contract: same payload -> same
 * response, byte for byte. Neutral wording only, no domain assumptions,
 * no network. Every response it returns has passed validateAiResponse
 * against the payload it was given, so the mock can never smuggle an
 * invalid shape into the UI.
 */
import type { AiProviderPayload, ContextItem } from "./context";
import { validateAiResponse, type AiOutputItem, type AiResponseResult } from "./response";
import type { AiTaskProvider } from "./task-provider";

const firstSentence = (text: string): string => {
  const m = text.trim().match(/^[^.!?\n]+[.!?]?/);
  return (m ? m[0] : text.trim()).trim();
};
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const find = (payload: AiProviderPayload, kind: ContextItem["kind"]) => payload.items.filter((i) => i.kind === kind);

export function mockItemsFor(payload: AiProviderPayload): AiOutputItem[] {
  const system = find(payload, "system")[0];
  const userText = find(payload, "user_text")[0];
  switch (payload.task) {
    case "extract_statements":
    case "propose_observation_from_user_statement": {
      if (!userText) return [];
      const quote = firstSentence(str(userText.payload.text));
      return [{ kind: "extraction", id: "out_1", text: `The text states: ${quote}`, quote, sourceRef: userText.id, ...(system ? { subjectRef: system.id } : {}), state: "directly_stated" }];
    }
    case "interpret_free_text": {
      if (!userText) return [];
      const value = find(payload, "value")[0];
      const restsOn = value ? [userText.id, value.id] : [userText.id];
      const items: AiOutputItem[] = [
        { kind: "interpretation", id: "out_1", text: value ? `One tentative reading: the statement may bear on the recorded condition “${str(value.payload.variable)}”, whose reading in this context is ${str(value.payload.basis).replace(/_/g, " ")}.` : "One tentative reading: the statement describes a condition the model does not yet record.", restsOn, state: "tentative", caveat: "This is a reading of the words supplied, not a recorded value, and it may be mistaken." },
      ];
      if (value) items.push({ kind: "question", id: "out_2", text: `Is “${str(value.payload.variable)}” recorded for the period the statement covers?`, targets: [value.id], whyItMatters: "Without a recorded value for that period the statement cannot be compared with the model." });
      return items;
    }
    case "suggest_explanations_for_pattern": {
      const pattern = find(payload, "pattern")[0];
      const cc = find(payload, "cross_context")[0];
      if (!pattern) return [];
      const result = cc ? (cc.payload.result as { groups?: Record<string, string[]> } | undefined) : undefined;
      const groups = result?.groups;
      const distinguishing = groups?.differentiatingComplete?.length ?? 0;
      const unresolved = (groups?.insufficientAtOccurrences?.length ?? 0) + (groups?.undecided?.length ?? 0) + (groups?.contrastPartial?.length ?? 0);
      const restsOn = cc ? [pattern.id, cc.id] : [pattern.id];
      const text = cc && groups
        ? `One possibility is that a condition recorded the same at every occurrence and differently at the contrast times is part of what surrounds this repetition; the comparison lists ${distinguishing} such condition${distinguishing === 1 ? "" : "s"}.`
        : "One possibility cannot be framed here: the Explore comparison is not part of this context.";
      return [
        { kind: "candidate_explanation", id: "out_1", text, forPattern: pattern.id, restsOn, state: cc && groups ? "tentative" : "unresolved", weakenedBy: ["A contrast time at which that condition holds while the pattern still does not occur.", "A recorded reason for the repetition that the records do not yet carry."], alternatives: ["The repetition may reflect how and when values were recorded rather than a condition of the system."] },
        { kind: "question", id: "out_2", text: `Which of the ${unresolved} unresolved condition${unresolved === 1 ? "" : "s"} could be recorded for the occurrence times?`, targets: restsOn, whyItMatters: "An unresolved condition can neither support nor weaken a candidate until it is recorded." },
      ];
    }
    case "suggest_questions_to_reduce_uncertainty": {
      const values = find(payload, "value").slice(0, 3);
      return values.map((v, i) => ({ kind: "question" as const, id: `out_${i + 1}`, text: `What was “${str(v.payload.variable)}” as of ${str(v.id).split("@")[1] ?? "that time"}? The context shows it as ${str(v.payload.basis).replace(/_/g, " ")}.`, targets: [v.id], whyItMatters: "A recorded value would replace a carried, unknown or ambiguous reading." }));
    }
    case "summarize_model": {
      const sections: { heading: string; text: string; cites: string[] }[] = [];
      if (system) sections.push({ heading: "Subjects", text: `The context covers ${((system.payload.subjects as { label: string }[] | undefined) ?? []).map((s) => s.label).join(", ") || "the system"}.`, cites: [system.id] });
      const values = find(payload, "value");
      if (values.length) sections.push({ heading: "Recorded values", text: `${values.length} value reading${values.length === 1 ? "" : "s"} are supplied, each with its basis (${[...new Set(values.map((v) => str(v.payload.basis).replace(/_/g, " ")))].join(", ")}).`, cites: values.map((v) => v.id) });
      const hyps = find(payload, "hypothesis");
      if (hyps.length) sections.push({ heading: "Working hypotheses", text: `${hyps.length} hypothes${hyps.length === 1 ? "is is" : "es are"} recorded; their status and confidence are the person's own entries.`, cites: hyps.map((h) => h.id) });
      return sections.length ? [{ kind: "summary", id: "out_1", sections }] : [];
    }
  }
}

export class MockAiTaskProvider implements AiTaskProvider {
  readonly name = "task-mock";
  async run(payload: AiProviderPayload, contextHash: string): Promise<AiResponseResult> {
    const response = { version: 1 as const, task: payload.task, contextHash, items: mockItemsFor(payload) };
    return validateAiResponse(response, payload, contextHash);
  }
}
