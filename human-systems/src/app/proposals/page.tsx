"use client";
/**
 * PROPOSALS — the review inbox for the active system. Every proposal here
 * was materialized and previewed by the kernel; nothing on this page
 * writes to the model except an explicit approval, which goes through
 * ProposalService.approve -> guarded persistence -> the provider adopting
 * the persisted model. Cards that can act appear only after startup
 * recovery has reconciled any proposal stranded in "applying".
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useModel } from "@/components/model-provider";
import { ProposalCard, type ProposalActions } from "@/components/proposal-card";
import { ProposalCompose, type ComposeSubmit } from "@/components/proposal-compose";
import { Card, Loading, Note, PageHeader } from "@/components/ui";
import type { MutationProposal, RecoveryOutcome } from "@/kernel";

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50 disabled:cursor-not-allowed";
const REVALIDATED = new Set<MutationProposal["status"]>(["proposed", "reviewed", "stale"]);

function recoveryWords(o: RecoveryOutcome): string {
  switch (o.outcome) {
    case "reconciled_applied":
      return `Proposal ${o.proposalId}: the stored system already carries this change; it is recorded as applied.`;
    case "commit_never_landed":
      return `Proposal ${o.proposalId}: the change was approved but never reached the stored system; it is marked as not applied and can be retried after a check.`;
    case "conflict":
      return `Proposal ${o.proposalId}: the stored system is neither the state before nor the state after this change; it is marked as not applied and needs a fresh look before any retry.`;
  }
}

function ProposalsInner() {
  const { status, model, proposals, proposalRecovery, approveProposal } = useModel();
  const focus = useSearchParams().get("focus");
  const [items, setItems] = useState<MutationProposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState<false | { editing: MutationProposal | null }>(false);
  const [showHistory, setShowHistory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Revalidate every reviewable proposal against the STORED model whenever
  // the active model changes, so staleness is decided by the kernel, never
  // by the page. Recovery must have finished first.
  const reload = useCallback(async () => {
    if (!proposals || !model || proposalRecovery.status !== "done") return;
    try {
      const all = await proposals.list(model.id);
      const next = await Promise.all(all.map((p) => (REVALIDATED.has(p.status) ? proposals.revalidate(p.id) : p)));
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setItems(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [proposals, model, proposalRecovery.status]);

  useEffect(() => {
    // the ledger is an external store: state is set only after awaiting it
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  // navigation only: bring the focused proposal into view once it is rendered
  useEffect(() => {
    if (!focus || !items) return;
    document.querySelector(`[data-proposal-id="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "start" });
  }, [focus, items]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const actions: ProposalActions = {
    review: (id, note) => act(() => proposals!.review(id, note)),
    approve: async (id, note) => {
      setBusy(true);
      try {
        return await approveProposal(id, note);
      } finally {
        setBusy(false);
        await reload();
      }
    },
    reject: (id, note) => act(() => proposals!.reject(id, note)),
    retry: (id) => act(() => proposals!.retry(id)),
    edit: (p) => setComposing({ editing: p }),
  };

  const submitCompose = async (input: ComposeSubmit) => {
    if (!proposals || !model) return;
    if (composing && composing.editing) await proposals.edit(composing.editing.id, input.request, "edited");
    else await proposals.create({ modelId: model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis });
    setComposing(false);
    await reload();
  };

  if (status === "loading" || !model) return <Loading />;

  const open = (items ?? []).filter((p) => ["proposed", "stale", "failed", "applying"].includes(p.status));
  const ready = (items ?? []).filter((p) => p.status === "reviewed");
  const history = (items ?? []).filter((p) => ["applied", "rejected", "superseded"].includes(p.status));

  return (
    <div>
      <PageHeader title="Proposals" lede="Changes waiting for your decision. The engine shows exactly what each one does; you decide whether it is right. Nothing here changes the system until you approve it." />

      {proposalRecovery.status === "pending" ? <Note>Checking for changes that were approved but not completed…</Note> : null}
      {proposalRecovery.status === "error" ? <Note tone="warn">The proposal ledger could not be read: {proposalRecovery.message}. Nothing is shown or written until it is inspected.</Note> : null}
      {proposalRecovery.status === "done" && proposalRecovery.outcomes.length > 0 ? (
        <Card title="Recovered on startup" tone="warn" className="mb-4">
          <ul className="text-sm space-y-1" data-testid="recovery-outcomes">
            {proposalRecovery.outcomes.map((o) => (
              <li key={o.proposalId}>{recoveryWords(o)}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {loadError ? <Note tone="warn">{loadError}</Note> : null}

      <div className="mb-4">
        {composing ? (
          <Card title={composing.editing ? "Edit proposal" : "Propose a change"}>
            <ProposalCompose model={model} editing={composing.editing} onSubmit={submitCompose} onCancel={() => setComposing(false)} />
          </Card>
        ) : (
          <button type="button" className={BTN} onClick={() => setComposing({ editing: null })} disabled={proposalRecovery.status !== "done"}>
            Propose a change
          </button>
        )}
      </div>

      {proposalRecovery.status === "done" && items !== null ? (
        <div className="space-y-6">
          <section aria-labelledby="needs-review">
            <h2 id="needs-review" className="text-sm font-semibold mb-2">
              Needs your review ({open.length})
            </h2>
            {open.length === 0 ? <p className="text-sm text-muted">Nothing is waiting for review.</p> : <div className="space-y-3">{open.map((p) => <ProposalCard key={p.id} p={p} actions={actions} busy={busy} focused={p.id === focus} />)}</div>}
          </section>
          <section aria-labelledby="ready">
            <h2 id="ready" className="text-sm font-semibold mb-2">
              Reviewed — ready for your decision ({ready.length})
            </h2>
            {ready.length === 0 ? <p className="text-sm text-muted">No reviewed proposal is waiting for a decision.</p> : <div className="space-y-3">{ready.map((p) => <ProposalCard key={p.id} p={p} actions={actions} busy={busy} focused={p.id === focus} />)}</div>}
          </section>
          <section aria-labelledby="history">
            <h2 id="history" className="text-sm font-semibold mb-2">
              <button type="button" className="underline decoration-dotted" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
                History ({history.length})
              </button>
            </h2>
            {showHistory ? (history.length === 0 ? <p className="text-sm text-muted">No decided proposal yet.</p> : <div className="space-y-3">{history.map((p) => <ProposalCard key={p.id} p={p} actions={actions} busy={busy} />)}</div>) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default function ProposalsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProposalsInner />
    </Suspense>
  );
}
