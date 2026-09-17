/**
 * THE RESEARCH AGENT RUN (Step 7B): captures → proposals, minus what is
 * already on file. Repeated retrieval never manufactures persistence or
 * corroboration: the same item (source + key) with the same content is
 * proposed once, whatever the version; a materially changed item is
 * proposed again, and the pending proposal for the old content goes stale
 * on its own through the source_item basis. The agent reads the ledger and
 * the model; it writes only through ProposalService.create.
 */
import type { MutationProposal } from "@/kernel/types";
import type { ProposalService } from "@/kernel/service";
import type { SystemModel } from "@/types";
import { captureEvidence, captureProposal, type EvidenceCapture } from "./capture";
import type { SourceSnapshot } from "./source";
import type { Thesis } from "./thesis";

export type SkipReason = "already_recorded" | "already_proposed";

export interface AgentPlan {
  captures: EvidenceCapture[];
  proposals: { capture: EvidenceCapture; input: ReturnType<typeof captureProposal> }[];
  skipped: { capture: EvidenceCapture; reason: SkipReason }[];
}

/** Statuses under which an earlier proposal for the same content still speaks for it. */
const COUNTS: ReadonlySet<MutationProposal["status"]> = new Set(["proposed", "reviewed", "stale", "failed", "applying", "applied"]);

/** An approved record of this exact content already in the model (by evidence source + locator + content). */
function alreadyRecorded(model: SystemModel, c: EvidenceCapture): boolean {
  const v = model.variables.find((x) => x.id === c.variableId);
  return (v?.values ?? []).some((e) => e.status === "active" && e.value === c.item.value && e.evidence.some((ev) => ev.source?.id === c.snapshot.id && ev.source.locator === (c.item.locator ?? c.item.key) && ev.quote === c.item.quote && ev.period === c.item.period.text));
}

function alreadyProposed(ledger: readonly MutationProposal[], c: EvidenceCapture): boolean {
  return ledger.some((p) => COUNTS.has(p.status) && p.basis.some((b) => b.kind === "source_item" && b.sourceId === c.snapshot.id && b.itemKey === c.item.key && b.contentHash === c.contentHash));
}

export function planRun(model: SystemModel, ledger: readonly MutationProposal[], thesis: Thesis, snapshot: SourceSnapshot): AgentPlan {
  const captures = captureEvidence(model, thesis, snapshot);
  const plan: AgentPlan = { captures, proposals: [], skipped: [] };
  for (const capture of captures) {
    if (alreadyRecorded(model, capture)) plan.skipped.push({ capture, reason: "already_recorded" });
    else if (alreadyProposed(ledger, capture)) plan.skipped.push({ capture, reason: "already_proposed" });
    else plan.proposals.push({ capture, input: captureProposal(capture, thesis, model.id) });
  }
  return plan;
}

export interface AgentRunResult {
  created: MutationProposal[];
  skipped: AgentPlan["skipped"];
}

/** Plan against the stored ledger, then create each proposal. Never touches the model. */
export async function runAgent(service: ProposalService, model: SystemModel, thesis: Thesis, snapshot: SourceSnapshot): Promise<AgentRunResult> {
  const ledger = await service.list(model.id);
  const plan = planRun(model, ledger, thesis, snapshot);
  const created: MutationProposal[] = [];
  for (const p of plan.proposals) created.push(await service.create(p.input));
  return { created, skipped: plan.skipped };
}
