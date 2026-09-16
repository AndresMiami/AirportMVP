"use client";
/**
 * A person proposing a change THROUGH the kernel (and editing an existing
 * proposal, which supersedes it). Step 2 device: the request is entered as
 * the registered kind plus its JSON arguments, with a template per kind;
 * the kernel materializes and previews it exactly as it would for any
 * other proposer. Later steps (Explore, AI) build the same request shape.
 */
import { useState } from "react";
import { REGISTERED_KINDS, type MutationBatch, type MutationProposal, type ProposalBasisRef } from "@/kernel";
import type { SystemModel } from "@/types";

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50 disabled:cursor-not-allowed";
const PRIMARY = "rounded bg-accent text-white px-2.5 py-1 text-xs hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";

function templateFor(kind: string, model: SystemModel): Record<string, unknown> {
  const v = model.variables.find((x) => x.kind === "input");
  const h = model.hypotheses[0];
  const o = model.observations[0];
  switch (kind) {
    case "addObservation":
      return { statement: "", sourceType: "self_reported", confidence: 0.6, dateOrPeriod: "" };
    case "addHypothesis":
      return { statement: "", confidence: 0.3, disconfirmingConditions: [] };
    case "addEvent":
      return { kind: "shock", type: "other", title: "", occurred: { kind: "instant", start: new Date().toISOString().slice(0, 10), precision: "date", text: "" }, recordedAt: new Date().toISOString(), sourceType: "self_reported", confidence: 0.6 };
    case "addVariable":
      return { name: "", category: "buffer", changeSpeed: "slow", unit: "", subjectId: model.id };
    case "addMember":
      return { label: "", role: "" };
    case "addRelationship":
      return { sourceVariableId: v?.id ?? "", targetVariableId: "", direction: "positive", strength: 0.5, lag: { value: 1, unit: "months" }, confidence: 0.5, sourceType: "self_reported", kind: "causal_hypothesis" };
    case "addConstraint":
      return { name: "", type: "soft", sourceType: "self_reported", confidence: 0.8 };
    case "recordValue":
      return { variableId: v?.id ?? "", input: { value: 0, sourceType: "self_reported", confidence: 0.7 } };
    case "recordTarget":
      return { variableId: v?.id ?? "", input: { desiredValue: 0 } };
    case "linkObservation":
      return { observationId: o?.id ?? "", target: { kind: "variable", id: v?.id ?? "" } };
    case "attachObservationToHypothesis":
      return { hypothesisId: h?.id ?? "", observationId: o?.id ?? "", role: "supporting" };
    case "addDisconfirmingCondition":
      return { hypothesisId: h?.id ?? "", condition: "" };
    case "addKillCriterion":
      return { hypothesisId: h?.id ?? "", input: { statement: "" } };
    default:
      return {};
  }
}

export interface ComposeSubmit {
  request: MutationBatch;
  rationale: string;
  basis: ProposalBasisRef[];
}

export function ProposalCompose({ model, editing, onSubmit, onCancel }: { model: SystemModel; editing: MutationProposal | null; onSubmit: (input: ComposeSubmit) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<string>(editing?.request[0]?.kind ?? "addObservation");
  const [args, setArgs] = useState<string>(editing ? JSON.stringify(editing.request.length === 1 ? editing.request[0].args : editing.request, null, 2) : JSON.stringify(templateFor("addObservation", model), null, 2));
  const [rationale, setRationale] = useState(editing?.rationale ?? "");
  const [cited, setCited] = useState<Set<string>>(new Set(editing?.basis.flatMap((b) => (b.kind === "observation" ? [b.id] : [])) ?? []));
  const [said, setSaid] = useState(editing?.basis.find((b) => b.kind === "user_statement")?.kind === "user_statement" ? (editing.basis.find((b) => b.kind === "user_statement") as { text: string }).text : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const multi = editing !== null && editing.request.length > 1;

  const pick = (k: string) => {
    setKind(k);
    setArgs(JSON.stringify(templateFor(k, model), null, 2));
  };
  const submit = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      setError("The arguments are not valid JSON.");
      return;
    }
    const request = (multi ? parsed : [{ kind, args: parsed }]) as MutationBatch;
    const basis: ProposalBasisRef[] = [...cited].map((id) => ({ kind: "observation" as const, id }));
    if (said.trim()) basis.push({ kind: "user_statement", text: said.trim() });
    setBusy(true);
    try {
      await onSubmit({ request, rationale, basis });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label={editing ? "Edit proposal" : "Propose a change"}
    >
      {editing ? <p className="text-xs text-muted">Editing creates a NEW proposal and marks the current one as replaced. Nothing is applied until the new one is reviewed and approved.</p> : null}
      {!multi ? (
        <label className="block">
          <span className="text-xs text-muted">Kind of change</span>
          <select className="mt-0.5 block" value={kind} onChange={(e) => pick(e.target.value)} disabled={busy}>
            {REGISTERED_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-muted">This proposal has several steps; the whole request is edited as JSON.</p>
      )}
      <label className="block">
        <span className="text-xs text-muted">{multi ? "Request (JSON)" : "Arguments (JSON)"}</span>
        <textarea className="mt-0.5 block w-full max-w-xl font-mono text-xs" rows={8} value={args} onChange={(e) => setArgs(e.target.value)} disabled={busy} aria-label="Arguments" />
      </label>
      <label className="block">
        <span className="text-xs text-muted">Why (your reason, kept with the proposal)</span>
        <input type="text" className="mt-0.5 block w-full max-w-xl" value={rationale} onChange={(e) => setRationale(e.target.value)} disabled={busy} aria-label="Why" />
      </label>
      {model.observations.length > 0 ? (
        <fieldset>
          <legend className="text-xs text-muted">Records this is based on (observations)</legend>
          <ul className="mt-0.5 max-h-40 overflow-auto space-y-0.5">
            {model.observations.slice(0, 40).map((o) => (
              <li key={o.id}>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={cited.has(o.id)}
                    disabled={busy}
                    onChange={(e) => {
                      const next = new Set(cited);
                      if (e.target.checked) next.add(o.id);
                      else next.delete(o.id);
                      setCited(next);
                    }}
                  />
                  <span>{o.statement}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <label className="block">
        <span className="text-xs text-muted">In your own words (optional; recorded as a statement, not as evidence)</span>
        <input type="text" className="mt-0.5 block w-full max-w-xl" value={said} onChange={(e) => setSaid(e.target.value)} disabled={busy} aria-label="In your own words" />
      </label>
      {error ? (
        <p className="text-xs text-warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY} disabled={busy}>
          {editing ? "Propose the edited version" : "Propose"}
        </button>
        <button type="button" className={BTN} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
