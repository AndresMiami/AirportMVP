"use client";
/**
 * The REVIEW CARD: one proposal in ordinary language, answering what is
 * proposed, why, what changes, what else changes, what does not, which
 * records it rests on, and what stays uncertain. The mechanical diff sits
 * under Details. A stale card shows what was reviewed before, what changed
 * since, and what the proposal would do now; approval stays unavailable
 * until the person explicitly reviews the new version. A consequential
 * proposal needs a second confirmation that NAMES the consequence. No
 * default approval, no timers, no prechecked boxes, no approve-all.
 */
import { useState } from "react";
import { BASIS_DISCLAIMER, STATUS_WORDS, describeProposal, staleComparison, type ApproveResult, type EntityChange, type MutationProposal, type ProposalWording } from "@/kernel";

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50 disabled:cursor-not-allowed";
const PRIMARY = "rounded bg-accent text-white px-2.5 py-1 text-xs hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";

export interface ProposalActions {
  review: (id: string, note: string) => Promise<void>;
  approve: (id: string, note: string) => Promise<ApproveResult>;
  reject: (id: string, note: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  edit: (p: MutationProposal) => void;
}

function authorWords(p: MutationProposal): string {
  switch (p.proposedBy.kind) {
    case "person":
      return p.proposedBy.actorId ? `Proposed by ${p.proposedBy.actorId}` : "Proposed by you";
    case "ai":
      return `Proposed by an AI adapter (${p.proposedBy.adapterId})`;
    case "system_feature":
      return `Proposed by the feature “${p.proposedBy.featureId}”`;
  }
}

function Section({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted">{q}</h3>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

function Lines({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <ul className="list-disc pl-5 space-y-0.5">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

function Wording({ w }: { w: ProposalWording }) {
  return (
    <div className="space-y-3">
      <Section q="What is being proposed?">
        <Lines items={w.what} empty="Nothing can be described: the proposal cannot be applied." />
      </Section>
      <Section q="Why was it proposed?">
        <p>{w.why}</p>
      </Section>
      <Section q="What will change?">
        {w.willChange.length === 0 ? (
          <p className="text-muted">Nothing: it cannot be applied.</p>
        ) : (
          <ul className="space-y-1">
            {w.willChange.map((c, i) => (
              <li key={i}>
                {c.summary}
                {c.subject ? <span className="text-xs text-muted"> · {c.subject}</span> : null}
                {c.details.length > 0 ? <div className="text-xs text-muted">{c.details.join(" ")}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section q="What else will change?">
        <Lines items={w.elseChanges} empty="Nothing the request did not name." />
      </Section>
      <Section q="What will not change?">
        <p>{w.willNotChange}</p>
      </Section>
      <Section q="What records is this based on?">
        <Lines items={w.basis.map((b) => b.text)} empty="No record was cited." />
        <p className="mt-1 text-xs text-muted">{BASIS_DISCLAIMER}</p>
      </Section>
      <Section q="What uncertainty remains?">
        <Lines items={w.uncertainty} empty="" />
      </Section>
      {w.errors.length > 0 ? (
        <Section q="Why it cannot be applied">
          <Lines items={w.errors} empty="" />
        </Section>
      ) : null}
    </div>
  );
}

function Details({ changes }: { changes: EntityChange[] }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs text-muted">Details: the mechanical diff ({changes.length} row{changes.length === 1 ? "" : "s"})</summary>
      {changes.length === 0 ? (
        <p className="mt-1 text-xs text-muted">No rows.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-xs">
          {changes.map((c) => (
            <li key={`${c.collection}:${c.id}`} className="rounded border border-border p-2">
              <div className="font-mono">
                {c.op} {c.collection} / {c.id}
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-all text-muted">{JSON.stringify(c.op === "removed" ? c.before : c.after, null, 1)}</pre>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function ProposalCard({ p, actions, busy, focused = false }: { p: MutationProposal; actions: ProposalActions; busy: boolean; focused?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const w = describeProposal(p);
  const stale = p.status === "stale" ? staleComparison(p) : null;
  const consequential = p.preview.consequenceClass === "consequential";
  const canApprove = p.status === "reviewed" && p.preview.ok;
  const lastNote = p.review.at(-1)?.note ?? "";

  const run = async (f: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const approve = () =>
    run(async () => {
      const r = await actions.approve(p.id, note);
      setConfirming(false);
      if (!r.ok) setMessage(r.message);
    });

  return (
    <article className={`rounded-lg border ${p.status === "stale" || p.status === "failed" ? "border-warn" : consequential && p.status === "reviewed" ? "border-warn" : "border-border"} bg-surface p-4 ${focused ? "ring-2 ring-accent" : ""}`} aria-labelledby={`${p.id}-title`} data-proposal-id={p.id} data-status={p.status}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${p.id}-title`} className="text-sm font-semibold">
          {w.what[0] ?? "A change that cannot be applied"}
          {w.what.length > 1 ? <span className="text-muted font-normal"> and {w.what.length - 1} more step{w.what.length > 2 ? "s" : ""}</span> : null}
        </h2>
        <span className={`rounded px-1.5 py-0.5 text-xs ${p.status === "applied" ? "bg-desired-soft text-desired" : p.status === "stale" || p.status === "failed" ? "bg-warn-soft text-warn" : "bg-background border border-border"}`}>{STATUS_WORDS[p.status]}</span>
      </header>
      <p className="mt-0.5 text-xs text-muted">
        {authorWords(p)} · {p.createdAt.slice(0, 16).replace("T", " ")} · {consequential ? "consequential" : "ordinary"} change
        {p.supersededBy ? ` · replaced by ${p.supersededBy}` : null}
      </p>

      {stale ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-warn bg-warn-soft p-3 text-sm">
            <h3 className="text-xs font-semibold">What changed since then</h3>
            <Lines items={stale.changedSince} empty="" />
            <p className="mt-1 text-xs">{lastNote}</p>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted">What you reviewed before</summary>
            <div className="mt-2 rounded-md border border-border p-3">
              <Wording w={stale.before} />
            </div>
          </details>
          <div>
            <h3 className="text-xs font-semibold mb-1">What the proposal would do now</h3>
            <div className="rounded-md border border-border p-3">
              <Wording w={stale.now} />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          {p.status === "failed" ? (
            <p className="mb-3 rounded-md border border-warn bg-warn-soft p-3 text-sm">
              Nothing was written. {lastNote}
              {p.commit ? "" : ""}
            </p>
          ) : null}
          {p.status === "applying" ? <p className="mb-3 rounded-md border border-warn bg-warn-soft p-3 text-sm">This proposal is being applied. If this line does not go away, reload the page: startup recovery reads the stored model and reconciles it.</p> : null}
          <Wording w={w} />
        </div>
      )}
      <Details changes={p.preview.changes} />

      {p.status === "proposed" || p.status === "reviewed" || p.status === "stale" || p.status === "failed" ? (
        <footer className="mt-4 space-y-2">
          <label className="block text-xs text-muted">
            Note (optional, kept with the decision)
            <input type="text" className="mt-0.5 block w-full max-w-md" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
          </label>
          {confirming ? (
            <div className="rounded-md border border-warn bg-warn-soft p-3 text-sm" role="group" aria-label="Second confirmation">
              <p className="font-semibold">This change is consequential.</p>
              <Lines items={w.consequences} empty="The kernel classifies this proposal as consequential." />
              <p className="mt-1 text-xs">The record after this change no longer says what it says now. Nothing is applied until you confirm.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} onClick={approve} disabled={busy}>
                  Yes, apply this consequential change
                </button>
                <button type="button" className={BTN} onClick={() => setConfirming(false)} disabled={busy}>
                  Not now
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {p.status === "proposed" ? (
                <button type="button" className={PRIMARY} onClick={() => run(() => actions.review(p.id, note))} disabled={busy}>
                  I have reviewed this
                </button>
              ) : null}
              {p.status === "stale" ? (
                <button type="button" className={PRIMARY} onClick={() => run(() => actions.review(p.id, note))} disabled={busy}>
                  I have reviewed the new version
                </button>
              ) : null}
              {p.status === "failed" ? (
                <button type="button" className={PRIMARY} onClick={() => run(() => actions.retry(p.id))} disabled={busy}>
                  Check again and retry
                </button>
              ) : null}
              {p.status === "reviewed" ? (
                <button type="button" className={PRIMARY} onClick={consequential ? () => setConfirming(true) : approve} disabled={busy || !canApprove} title={canApprove ? undefined : "This proposal cannot be applied as it stands."}>
                  {consequential ? "Approve…" : "Approve and apply"}
                </button>
              ) : null}
              <button type="button" className={BTN} onClick={() => run(() => actions.reject(p.id, note))} disabled={busy}>
                Reject
              </button>
              <button type="button" className={BTN} onClick={() => actions.edit(p)} disabled={busy}>
                Edit
              </button>
            </div>
          )}
          {message ? (
            <p className="text-xs text-warn" role="alert">
              {message}
            </p>
          ) : null}
        </footer>
      ) : null}
      {p.status === "applied" && p.commit ? <p className="mt-3 text-xs text-muted">Applied {p.commit.approvedAt?.slice(0, 16).replace("T", " ")} · {p.commit.affectedIds.length} record{p.commit.affectedIds.length === 1 ? "" : "s"} affected.</p> : null}
      {p.status === "rejected" ? <p className="mt-3 text-xs text-muted">Rejected{lastNote ? `: ${lastNote}` : "."}</p> : null}
    </article>
  );
}
