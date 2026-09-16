"use client";
/**
 * REVIEW (Step 6D: simplified presentation, same approval semantics) —
 * "Nothing changes until you decide." Every proposal here was materialized
 * and previewed by the kernel; nothing on this page writes to the model
 * except an explicit approval, which goes through ProposalService.approve
 * -> guarded persistence -> the provider adopting the persisted model.
 * Cards that can act appear only after startup recovery has reconciled
 * any proposal stranded in "applying". The route stays /proposals.
 *
 * Order: a focused proposal (?focus=id, the one Explore just created)
 * first; other actionable proposals under "Other things waiting for you";
 * applied / rejected / superseded under a collapsed "Past decisions"; the
 * manual composer under a collapsed "Advanced" near the bottom.
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useModel } from "@/components/model-provider";
import { ProposalCard, type ProposalActions } from "@/components/proposal-card";
import { ProposalCompose, type ComposeSubmit } from "@/components/proposal-compose";
import { Loading, Note } from "@/components/ui";
import { recoveryLine } from "@/features/review/wording";
import type { MutationProposal } from "@/kernel";

const TOGGLE = "text-sm text-muted hover:text-foreground hover:underline disabled:opacity-50 disabled:cursor-not-allowed";
const REVALIDATED = new Set<MutationProposal["status"]>(["proposed", "reviewed", "stale"]);
const ACTIONABLE = new Set<MutationProposal["status"]>(["proposed", "reviewed", "stale", "failed", "applying"]);

function ProposalsInner() {
  const { status, model, proposals, proposalRecovery, approveProposal } = useModel();
  const focus = useSearchParams().get("focus");
  const [items, setItems] = useState<MutationProposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState<false | { editing: MutationProposal | null }>(false);
  const [showPast, setShowPast] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  const actionable = (items ?? []).filter((p) => ACTIONABLE.has(p.status));
  const focused = focus ? (actionable.find((p) => p.id === focus) ?? null) : null;
  const others = actionable.filter((p) => p.id !== focused?.id);
  const past = (items ?? []).filter((p) => ["applied", "rejected", "superseded"].includes(p.status));
  const ready = proposalRecovery.status === "done" && items !== null;

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Review</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">Check what would change before anything is added to your notebook. Nothing changes until you decide.</p>
      </header>

      {proposalRecovery.status === "pending" ? <Note>Checking for changes that were approved but not completed…</Note> : null}
      {proposalRecovery.status === "error" ? <Note tone="warn">Your past decisions could not be read: {proposalRecovery.message}. Nothing is shown or written until it is inspected.</Note> : null}
      {proposalRecovery.status === "done" && proposalRecovery.outcomes.length > 0 ? (
        <section className="mb-8 rounded-xl border border-warn/50 bg-warn-soft px-5 py-4" data-testid="recovery">
          <p className="text-sm font-medium">Checked on startup</p>
          <ul className="mt-1 space-y-1 text-[15px] leading-relaxed" data-testid="recovery-outcomes">
            {proposalRecovery.outcomes.map((o) => (
              <li key={o.proposalId}>{recoveryLine(o)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {loadError ? <Note tone="warn">{loadError}</Note> : null}

      {composing ? (
        <section className="mb-8 rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="composer">
          <p className="text-sm text-muted">{composing.editing ? "Edit proposal" : "Propose a change"}</p>
          <div className="mt-2">
            <ProposalCompose model={model} editing={composing.editing} onSubmit={submitCompose} onCancel={() => setComposing(false)} />
          </div>
        </section>
      ) : null}

      {ready ? (
        <div className="space-y-10">
          {focused ? (
            <section data-testid="focused">
              <ProposalCard p={focused} actions={actions} busy={busy} focused />
            </section>
          ) : null}

          {others.length > 0 ? (
            <section data-testid="others">
              {focused ? <h2 className="text-lg font-semibold tracking-tight">Other things waiting for you</h2> : null}
              <div className={focused ? "mt-2 space-y-4" : "space-y-4"}>
                {others.map((p) => (
                  <ProposalCard key={p.id} p={p} actions={actions} busy={busy} />
                ))}
              </div>
            </section>
          ) : null}

          {actionable.length === 0 ? <p className="text-[15px] text-muted">Nothing is waiting for your decision.</p> : null}

          <section data-testid="past">
            <button type="button" className={TOGGLE} onClick={() => setShowPast((s) => !s)} aria-expanded={showPast} data-testid="past-toggle">
              {showPast ? "Hide past decisions" : `Past decisions (${past.length})`}
            </button>
            {showPast ? (
              past.length === 0 ? (
                <p className="mt-2 text-[15px] text-muted">No decision yet.</p>
              ) : (
                <div className="mt-2 divide-y divide-border/70">
                  {past.map((p) => (
                    <ProposalCard key={p.id} p={p} actions={actions} busy={busy} />
                  ))}
                </div>
              )
            ) : null}
          </section>

          <section data-testid="advanced">
            <button type="button" className={TOGGLE} onClick={() => setShowAdvanced((s) => !s)} aria-expanded={showAdvanced} data-testid="advanced-toggle">
              {showAdvanced ? "Hide advanced" : "Advanced"}
            </button>
            {showAdvanced ? (
              <div className="mt-2 text-[15px] leading-relaxed text-muted">
                <p>Propose a change by hand: any registered mutation, as a request the kernel previews before you decide.</p>
                <button type="button" className={`mt-2 ${TOGGLE}`} onClick={() => setComposing({ editing: null })} disabled={proposalRecovery.status !== "done" || composing !== false}>
                  Propose a change
                </button>
              </div>
            ) : null}
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
