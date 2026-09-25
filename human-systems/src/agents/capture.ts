/**
 * EVIDENCE CAPTURE (Step 7B): a deterministic collector reads a source
 * snapshot for the variables a thesis watches and turns each matching item
 * into ONE proposal to record a value. Nothing here writes: the proposal
 * goes through Review, and the person decides.
 *
 * What the collector may propose is fixed by AGENT_MUTATION_KINDS:
 * recordValue only. It can never add, change or remove a hypothesis, a
 * prediction or a kill criterion, and it never invents a confidence: the
 * recorded confidence is null (not assessed) until a person assesses it.
 * The record keeps the SOURCE's provenance; the collector is named only on
 * the proposal.
 */
import type { CreateProposalInput } from "@/kernel/service";
import type { ProposalBasisRef } from "@/kernel/types";
import type { MutationStep } from "@/kernel/registry";
import type { Evidence, SystemModel, TemporalRef, TemporalPrecision } from "@/types";
import { itemContentHash, type SourceItem, type SourceSnapshot } from "./source";
import { collectableTargets, type Thesis, type ThesisTarget } from "./thesis";

export const RESEARCH_AGENT_ID = "research-agent";
/** The ONLY mutation a collector may propose. Pinned by test. */
export const AGENT_MUTATION_KINDS = ["recordValue"] as const satisfies readonly MutationStep["kind"][];

export interface EvidenceCapture {
  /** `${sourceId}#${itemKey}`: the same observation across retrievals. */
  identity: string;
  contentHash: string;
  target: ThesisTarget;
  variableId: string;
  variableName: string;
  item: SourceItem;
  snapshot: Pick<SourceSnapshot, "id" | "name" | "url" | "version" | "retrievedAt">;
}

const precisionOf = (iso: string): TemporalPrecision => (iso.length >= 10 ? "day" : iso.length === 7 ? "month" : iso.length === 4 ? "year" : "unspecified");

/** The period the source states, kept as stated: a range, a date, or unknown with the words. */
export function temporalRefOf(period: SourceItem["period"]): TemporalRef {
  if (period.start && period.end && period.end !== period.start) return { kind: "range", start: period.start, end: period.end, precision: precisionOf(period.start), text: period.text };
  if (period.start) return { kind: "date", start: period.start, precision: precisionOf(period.start), text: period.text };
  return { kind: "unknown", precision: "unspecified", text: period.text };
}

/** Every item of the snapshot that measures a variable the thesis watches. Pure; order = thesis targets, then source items. */
export function captureEvidence(model: SystemModel, thesis: Thesis, snapshot: SourceSnapshot): EvidenceCapture[] {
  const out: EvidenceCapture[] = [];
  for (const { target, variable } of collectableTargets(thesis, model)) {
    for (const item of snapshot.items) {
      if (item.variableKey !== variable.key) continue;
      const itemSubject = item.subjectId ?? model.id;
      if ((variable.subjectId ?? model.id) !== itemSubject) continue;
      out.push({ identity: `${snapshot.id}#${item.key}`, contentHash: itemContentHash(item), target, variableId: variable.id, variableName: variable.name, item, snapshot: { id: snapshot.id, name: snapshot.name, url: snapshot.url, version: snapshot.version, retrievedAt: snapshot.retrievedAt } });
    }
  }
  return out;
}

export function evidenceOf(c: EvidenceCapture): Evidence {
  return {
    text: `${c.snapshot.name} (version ${c.snapshot.version}), ${c.item.period.text}: “${c.item.quote}”`,
    sourceType: c.item.sourceType,
    recordedAt: c.snapshot.retrievedAt,
    source: { id: c.snapshot.id, name: c.snapshot.name, ...(c.snapshot.url ? { url: c.snapshot.url } : {}), version: c.snapshot.version, retrievedAt: c.snapshot.retrievedAt, locator: c.item.locator ?? c.item.key },
    period: c.item.period.text,
    quote: c.item.quote,
  };
}

export const sourceItemSummary = (c: EvidenceCapture): string => `${c.snapshot.name} (version ${c.snapshot.version}), ${c.item.period.text}: “${c.item.quote}” → ${c.item.value === null ? "unknown" : String(c.item.value)}`;

/** ONE recordValue proposal per capture. The collector is the author; the source's provenance is on the record. */
export function captureProposal(c: EvidenceCapture, thesis: Thesis, modelId: string): CreateProposalInput {
  const request: MutationStep[] = [
    {
      kind: "recordValue",
      args: {
        variableId: c.variableId,
        input: {
          value: c.item.value,
          sourceType: c.item.sourceType,
          confidence: null,
          valid: temporalRefOf(c.item.period),
          evidence: [evidenceOf(c)],
          note: `Collected for the ${c.target.kind === "prediction" ? "prediction" : "kill criterion"} “${c.target.statement}”.`,
        },
      },
    },
  ];
  const basis: ProposalBasisRef[] = [
    { kind: "source_item", sourceId: c.snapshot.id, itemKey: c.item.key, version: c.snapshot.version, contentHash: c.contentHash, summary: sourceItemSummary(c) },
    { kind: "hypothesis", id: thesis.id },
    { kind: "variable", id: c.variableId },
  ];
  return {
    modelId,
    request,
    proposedBy: { kind: "agent", agentId: RESEARCH_AGENT_ID, thesisId: thesis.id, sourceId: c.snapshot.id },
    rationale: `${c.snapshot.name} states a value of ${c.variableName} for ${c.item.period.text}, which the thesis “${thesis.statement}” watches through its ${c.target.kind === "prediction" ? "prediction" : "kill criterion"} “${c.target.statement}”. The record keeps the source's own provenance (${c.item.sourceType.replace(/_/g, " ")}); its confidence stays not assessed until you assess it.`,
    basis,
  };
}
