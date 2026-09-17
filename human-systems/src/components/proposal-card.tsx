"use client";
/**
 * The REVIEW CARD (Step 6D: simplified presentation, same approval
 * semantics). The first layer answers what am I deciding, what would
 * change, why am I seeing it, what is it based on — over the kernel's own
 * describeProposal() wording — and then offers ONE primary action for the
 * state: proposed -> "I've reviewed this" (ProposalService.review, never
 * approval); reviewed -> "Ready for your decision" + "Approve and apply"
 * (the guarded approval path); stale -> what changed since, then "I've
 * reviewed the updated version" before approval is possible; failed ->
 * "Nothing was written." + "Check again and retry" (explicit, never
 * automatic). A consequential proposal names its consequence up front and
 * still needs the second confirmation "Yes, apply this consequential
 * change". Reject and Edit stay secondary; the note is revealed on request.
 * Author, timestamps, ordinary/consequential label, ids, what else
 * changes, what will not, every uncertainty line, what was reviewed
 * before, and the mechanical diff all remain under Details. No default
 * approval, no timers, no prechecked boxes, no approve-all.
 */
import { useState } from "react";
import { BASIS_DISCLAIMER, STATUS_WORDS, describeProposal, staleComparison, type ApproveResult, type EntityChange, type MutationProposal, type ProposalWording } from "@/kernel";
import Link from "next/link";
import { NO_BASIS, STATE_LINES, basisRows, decisionDate, decisionHeading, explorePatternHref, firstLayerChanges, firstLayerWhy, specificUncertainty } from "@/features/review/wording";
import type { ResolvedBasis } from "@/kernel";

const TOGGLE = "text-sm text-muted hover:text-foreground hover:underline disabled:opacity-50 disabled:cursor-not-allowed";
const PRIMARY = "rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";

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

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** The first layer: what would change, why, based on what, still uncertain, and — when it cannot be applied — why. */
function FirstLayer({ p, w, resolved }: { p: MutationProposal; w: ProposalWording; resolved: readonly ResolvedBasis[] }) {
  const uncertain = specificUncertainty(w);
  const rows = basisRows(w.basis, resolved);
  const changes = firstLayerChanges(p, w);
  return (
    <div className="mt-4 space-y-4 text-[15px] leading-relaxed">
      <div data-testid="would-change">
        <Label>What this would change</Label>
        {changes.length === 0 ? (
          <p className="text-muted">Nothing: it cannot be applied.</p>
        ) : (
          <ul className="mt-0.5 space-y-1">
            {changes.map((c, i) => (
              <li key={i}>
                {c.summary}
                {c.subject ? <span className="text-sm text-muted"> · {c.subject}</span> : null}
                {c.details.length > 0 ? <span className="block text-sm text-muted">{c.details.join(" ")}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div data-testid="why">
        <Label>Why you&apos;re seeing this</Label>
        <p className="mt-0.5">{firstLayerWhy(p.basis, w)}</p>
        {explorePatternHref(p.basis) ? (
          <Link href={explorePatternHref(p.basis) as string} className="mt-1 inline-block text-sm text-accent hover:underline" data-testid="back-to-pattern">
            Open the pattern in Explore →
          </Link>
        ) : null}
      </div>
      <div data-testid="based-on">
        <Label>Based on</Label>
        {rows.length === 0 ? (
          <p className="mt-0.5 text-muted">{NO_BASIS}</p>
        ) : (
          <>
            <ul className="mt-0.5 space-y-2">
              {rows.map((b, i) => (
                <li key={i} className={b.resolved ? "" : "text-muted"}>
                  <span className="text-sm text-muted">{b.label}</span>
                  <span className="block">{b.text}</span>
                  {b.note ? <span className="block text-sm text-muted">{b.note}</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-sm text-muted">{BASIS_DISCLAIMER}</p>
          </>
        )}
      </div>
      {uncertain.length > 0 ? (
        <div data-testid="uncertain">
          <Label>Still uncertain</Label>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
            {uncertain.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {w.errors.length > 0 ? (
        <div data-testid="errors">
          <Label>Why it cannot be applied</Label>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
            {w.errors.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Everything the kernel says, in full, plus the record's bookkeeping and the mechanical diff. Nothing is removed from here. */
function FullWording({ w }: { w: ProposalWording }) {
  const lines = (items: string[], empty: string) => (items.length === 0 ? <p className="text-muted">{empty}</p> : <ul className="list-disc space-y-0.5 pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>);
  return (
    <div className="space-y-2 text-sm">
      <div>
        <p className="text-muted">What is being proposed</p>
        {lines(w.what, "Nothing can be described: the proposal cannot be applied.")}
      </div>
      <div>
        <p className="text-muted">Why it was proposed, in full</p>
        <p>{w.why}</p>
      </div>
      <div>
        <p className="text-muted">What will change, in full</p>
        {w.willChange.length === 0 ? <p className="text-muted">Nothing: it cannot be applied.</p> : <ul className="list-disc space-y-0.5 pl-5">{w.willChange.map((c, i) => <li key={i}>{c.summary}{c.subject ? ` · ${c.subject}` : ""}{c.details.length > 0 ? ` ${c.details.join(" ")}` : ""}</li>)}</ul>}
      </div>
      <div>
        <p className="text-muted">Records cited, as the kernel words them</p>
        {lines(w.basis.map((b) => b.text), "No record was cited.")}
      </div>
      <div>
        <p className="text-muted">What else will change</p>
        {lines(w.elseChanges, "Nothing the request did not name.")}
      </div>
      <div>
        <p className="text-muted">What will not change</p>
        <p>{w.willNotChange}</p>
      </div>
      <div>
        <p className="text-muted">Every uncertainty line</p>
        {lines(w.uncertainty, "")}
      </div>
      {w.consequences.length > 0 ? (
        <div>
          <p className="text-muted">Named consequences</p>
          {lines(w.consequences, "")}
        </div>
      ) : null}
    </div>
  );
}

function Diff({ changes }: { changes: EntityChange[] }) {
  return (
    <div className="text-sm" data-testid="mechanical-diff">
      <p className="text-muted">The mechanical diff ({changes.length} row{changes.length === 1 ? "" : "s"})</p>
      {changes.length === 0 ? (
        <p className="mt-1 text-muted">No rows.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {changes.map((c) => (
            <li key={`${c.collection}:${c.id}`} className="rounded-lg border border-border/70 p-2">
              <div className="font-mono text-xs">
                {c.op} {c.collection} / {c.id}
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-muted">{JSON.stringify(c.op === "removed" ? c.before : c.after, null, 1)}</pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A past decision as one compact row: outcome, the decision, the date, a
 *  note if one was left, and Details holding everything the record still
 *  knows (bookkeeping, the kernel's full wording, cited records, the
 *  mechanical diff). No actions: the decision is made. */
export function PastDecisionRow({ p }: { p: MutationProposal }) {
  const [open, setOpen] = useState(false);
  const w = describeProposal(p);
  const heading = decisionHeading(p, w);
  const date = decisionDate(p);
  const lastNote = p.review.at(-1)?.note ?? "";
  const consequential = p.preview.consequenceClass === "consequential";
  return (
    <li className="py-4" data-past-id={p.id} data-status={p.status}>
      <p className={`text-sm ${p.status === "applied" ? "text-desired" : "text-muted"}`}>{STATE_LINES[p.status]}</p>
      <p className="mt-0.5 text-[15px] leading-relaxed">{heading.detail ?? heading.question}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {date ? <span>{date}</span> : null}
        {p.status === "rejected" && lastNote ? <span>“{lastNote}”</span> : null}
        <button type="button" className={TOGGLE} aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          {open ? "Hide details" : "Details"}
        </button>
      </p>
      {open ? (
        <div className="mt-3 space-y-4 border-t border-border/70 pt-3" data-testid="past-details">
          <p className="text-sm text-muted">
            {heading.question} · {authorWords(p)} · created {p.createdAt.slice(0, 16).replace("T", " ")} · {consequential ? "consequential" : "ordinary"} change · {STATUS_WORDS[p.status]} · id {p.id}
            {p.supersededBy ? ` · replaced by ${p.supersededBy}` : ""}
            {p.status === "applied" && p.commit ? ` · applied ${p.commit.approvedAt?.slice(0, 16).replace("T", " ")} · ${p.commit.affectedIds.length} record${p.commit.affectedIds.length === 1 ? "" : "s"} affected` : ""}
          </p>
          {p.review.length > 0 ? <p className="text-sm text-muted">Decisions: {p.review.map((r) => `${r.status} (${r.by}${r.note ? `: ${r.note}` : ""})`).join(" → ")}</p> : null}
          <FullWording w={w} />
          <Diff changes={p.preview.changes} />
        </div>
      ) : null}
    </li>
  );
}

export function ProposalCard({ p, actions, busy, focused = false }: { p: MutationProposal; actions: ProposalActions; busy: boolean; focused?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const w = describeProposal(p);
  const stale = p.status === "stale" ? staleComparison(p) : null;
  const shown = stale ? stale.now : w;
  const heading = decisionHeading(p, shown);
  const consequential = p.preview.consequenceClass === "consequential";
  const canApprove = p.status === "reviewed" && p.preview.ok;
  const actionable = p.status === "proposed" || p.status === "reviewed" || p.status === "stale" || p.status === "failed";
  const lastNote = p.review.at(-1)?.note ?? "";
  const stateLine = STATE_LINES[p.status];

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

  const surface = focused || actionable ? `rounded-xl border bg-surface px-5 py-5 ${p.status === "stale" || p.status === "failed" ? "border-warn/50" : focused ? "border-accent/50" : "border-border/70"}` : "py-5";
  return (
    <article className={`${surface} ${focused ? "ring-2 ring-accent/20" : ""}`} aria-labelledby={`${p.id}-title`} data-proposal-id={p.id} data-status={p.status}>
      {stateLine ? (
        <p className={`text-sm ${p.status === "stale" || p.status === "failed" ? "font-medium text-warn" : "text-muted"}`} data-testid="state-line">
          {stateLine}
        </p>
      ) : null}
      {stale ? (
        <div className="mt-1 text-[15px] leading-relaxed" data-testid="changed-since">
          <ul className="list-disc space-y-0.5 pl-5">
            {stale.changedSince.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          {lastNote ? <p className="mt-1 text-sm text-muted">{lastNote}</p> : null}
        </div>
      ) : null}
      {p.status === "failed" && lastNote ? <p className="mt-1 text-sm text-muted">{lastNote}</p> : null}
      {p.status === "applying" ? <p className="mt-1 text-sm text-muted">If this line does not go away, reload the page: startup recovery reads the stored model and reconciles it.</p> : null}

      <h2 id={`${p.id}-title`} className={`${stateLine ? "mt-3" : ""} text-lg font-semibold tracking-tight`}>
        {heading.question}
      </h2>
      {heading.detail ? (
        <p className="mt-1 text-[17px] font-medium leading-snug" data-testid="decision-detail">
          {heading.detail}
          {heading.moreSteps > 0 ? <span className="text-sm font-normal text-muted"> and {heading.moreSteps} more step{heading.moreSteps > 1 ? "s" : ""}</span> : null}
        </p>
      ) : null}
      {consequential && actionable ? (
        <p className="mt-2 text-[15px] leading-relaxed text-warn" data-testid="consequence-notice">
          This is a consequential change: {w.consequences.length > 0 ? w.consequences.join(" ") : "the kernel classifies it as consequential."} It will ask you to confirm it a second time.
        </p>
      ) : null}

      <FirstLayer p={p} w={shown} resolved={p.resolvedBasis} />

      <div className="mt-4">
        <button type="button" className={TOGGLE} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((x) => !x)} data-testid="details-toggle">
          {detailsOpen ? "Hide details" : "Details"}
        </button>
        {detailsOpen ? (
          <div className="mt-3 space-y-4 border-t border-border/70 pt-3" data-testid="details">
            <p className="text-sm text-muted">
              {authorWords(p)} · created {p.createdAt.slice(0, 16).replace("T", " ")} · {consequential ? "consequential" : "ordinary"} change · {STATUS_WORDS[p.status]} · id {p.id}
              {p.supersededBy ? ` · replaced by ${p.supersededBy}` : ""}
              {p.status === "applied" && p.commit ? ` · applied ${p.commit.approvedAt?.slice(0, 16).replace("T", " ")} · ${p.commit.affectedIds.length} record${p.commit.affectedIds.length === 1 ? "" : "s"} affected` : ""}
            </p>
            {stale ? (
              <div data-testid="reviewed-before">
                <p className="text-sm font-medium">What you reviewed before</p>
                <div className="mt-1 rounded-lg border border-border/70 p-3">
                  <FullWording w={stale.before} />
                  <p className="mt-2 text-sm text-muted">Based on: {stale.before.basis.map((b) => b.text).join(" ") || "no record was cited."}</p>
                </div>
                <p className="mt-2 text-sm font-medium">What the proposal would do now</p>
              </div>
            ) : null}
            <FullWording w={shown} />
            <Diff changes={p.preview.changes} />
          </div>
        ) : null}
      </div>

      {actionable ? (
        <footer className="mt-5 space-y-3">
          {confirming ? (
            <div className="rounded-lg border border-warn/50 bg-warn-soft px-4 py-3 text-[15px] leading-relaxed" role="group" aria-label="Second confirmation">
              <p className="font-medium">This change is consequential.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {(w.consequences.length > 0 ? w.consequences : ["The kernel classifies this proposal as consequential."]).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <p className="mt-1 text-sm">The record after this change no longer says what it says now. Nothing is applied until you confirm.</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <button type="button" className={PRIMARY} onClick={approve} disabled={busy}>
                  Yes, apply this consequential change
                </button>
                <button type="button" className={TOGGLE} onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {p.status === "proposed" ? (
                <button type="button" className={PRIMARY} onClick={() => run(() => actions.review(p.id, note))} disabled={busy}>
                  I&apos;ve reviewed this
                </button>
              ) : null}
              {p.status === "stale" ? (
                <button type="button" className={PRIMARY} onClick={() => run(() => actions.review(p.id, note))} disabled={busy}>
                  I&apos;ve reviewed the updated version
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
              <button type="button" className={TOGGLE} onClick={() => run(() => actions.reject(p.id, note))} disabled={busy}>
                Reject
              </button>
              <button type="button" className={TOGGLE} onClick={() => actions.edit(p)} disabled={busy}>
                Edit
              </button>
              {!noteOpen ? (
                <button type="button" className={TOGGLE} onClick={() => setNoteOpen(true)} disabled={busy}>
                  Add a note
                </button>
              ) : null}
            </div>
          )}
          {noteOpen ? (
            <label className="block text-sm text-muted">
              Note (optional, kept with the decision)
              <input type="text" className="mt-1 block w-full max-w-md" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
            </label>
          ) : null}
          {message && message.trim() !== lastNote.trim() && !lastNote.includes(message.trim()) ? (
            <p className="text-sm text-warn" role="alert">
              {message}
            </p>
          ) : null}
        </footer>
      ) : null}
      {p.status === "rejected" && lastNote ? <p className="mt-2 text-sm text-muted">{lastNote}</p> : null}
    </article>
  );
}
