"use client";
/**
 * EXPLORE (Step 6C: simplified presentation, same comparison) — one human
 * question: "This kept happening. Why might that be?" The deterministic
 * cross-context engine provides the comparison; the person supplies the
 * explanation. The first layer reads as five questions in the same narrow
 * column as Home and History:
 *
 *   What was different each time?             -> differingAtOccurrences
 *   What was the same each time?              -> commonAtOccurrences
 *   How did the other recorded times compare? -> backgroundComplete /
 *                                                differentiatingComplete /
 *                                                mixedComplete (complete
 *                                                coverage only)
 *   What is still unresolved?                 -> insufficientAtOccurrences /
 *                                                undecided / contrastPartial
 *   What might explain this?                  -> the person's drafts, the
 *                                                domain's questions, and the
 *                                                hypotheses already linked
 *
 * Nothing here recomputes, ranks or writes: the wording module only words
 * the engine's groups; the recorded times, the engine's own statements and
 * counts, and every caveat sit behind toggles. "Investigate this
 * explanation" creates a PROPOSAL through the kernel exactly as in Step 4
 * (buildExploreProposal -> ProposalService.create -> /proposals?focus=id),
 * the person reviews it in Proposals, and only approval there creates the
 * hypothesis. Drafts stay in this browser, keyed by the full pattern.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useState } from "react";
import { providerPayload, type AiContext } from "@/ai/context";
import { suggestionState, toProposalSet, type AiProposalCandidate, type SuggestionState } from "@/ai/proposal-bridge";
import { ADAPTER_IDS, CONFIGURED_PROVIDER_KIND, createTaskProvider } from "@/ai/task-select";
import { AiDisclosure, AiFailure } from "@/components/ai-boundary";
import { useModel } from "@/components/model-provider";
import { Loading, Note } from "@/components/ui";
import { readConsent, writeConsent } from "@/features/ai/consent";
import { DISCLOSURE_PATTERN, THINKING_FAILED, citedLabels, needsDisclosure, providerBadge, sharedLines, stateWords } from "@/features/ai/wording";
import { exploreContext, visibleThinking, type ExploreThinking } from "@/features/explore/thinking";
import { CAUSATION_DISCLAIMER, INVESTIGATE_TEXT, INVESTIGATE_UNAVAILABLE_TEXT, contextSubjectsFor, crossContext, dayMonthYear, decodePatternRef, encodePatternRef, formatValue, linkedHypotheses, monthYear, type CrossContext, type PatternRef } from "@/discovery";
import { buildExploreProposal, createdFromPattern, mergeRelated, reconcileDraft, type ExploreDraft } from "@/features/explore/proposal";
import { EXPLORE_CAVEAT, NO_CONTRASTS_YET, exploreSections, proposalStatusLine, type ExploreRow } from "@/features/explore/wording";
import type { MutationProposal } from "@/kernel";
import { locusLabel, type DomainDefinition, type Locus } from "@/model/domain";
import { subjectLabelFor } from "@/model/subjects";
import type { SystemModel } from "@/types";

const LOCI: Locus[] = ["external_to_subject", "internal_to_subject", "interaction"];
const DRAFTS_KEY = "human-systems.explore-drafts.v1";
const TOGGLE = "text-sm text-muted hover:text-foreground hover:underline";
const ACTION = "text-[15px] font-medium text-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline";
const PRIMARY = "rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed";
const GROUP_THRESHOLD = 3;
const KIND = CONFIGURED_PROVIDER_KIND;

interface Draft extends ExploreDraft {
  locus: Locus;
}

/** Per-viewer drafts, in this browser only: never model state. */
function readDrafts(scope: string): Draft[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, Draft[]>;
    return Array.isArray(all[scope]) ? all[scope] : [];
  } catch {
    return [];
  }
}
function writeDrafts(scope: string, drafts: Draft[]): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, Draft[]>;
    all[scope] = drafts;
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: drafts live for this page only */
  }
}

/** A condition row: the plain sentence, a quiet tag when the distinction needs one, and the engine's statement and counts under Details. */
function ConditionRow({ row }: { row: ExploreRow }) {
  const [open, setOpen] = useState(false);
  const c = row.counts;
  return (
    <li className="py-3" data-explore-row={row.group} data-variable={row.variableId}>
      {row.tag ? <p className="text-sm text-muted">{row.tag}</p> : null}
      <p className="text-[15px] leading-relaxed">{row.text}</p>
      <button type="button" className={`mt-1 ${TOGGLE}`} aria-expanded={open} aria-label={`${open ? "Hide details" : "Details"} for ${row.text.split(/ changed each time| was | could not| is unknown/)[0]}`} onClick={() => setOpen((x) => !x)}>
        {open ? "Hide details" : "Details"}
      </button>
      {open ? (
        <div className="mt-2 space-y-1 text-sm text-muted" data-testid="condition-details">
          <p>{row.statement}</p>
          <p>
            Readable at {c.occurrenceUsable} of {c.occurrenceTotal} occurrences. Other recorded times: {c.contrastSame} the same, {c.contrastDifferent} different, {c.contrastUsable} of {c.contrastTotal} readable.
            {c.reliesOnRecordedBasis ? " Relies partly on dates known only from when the information was recorded." : ""}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/** Rows above the threshold read as one line until asked for (the History treatment). */
function Rows({ rows, collapsible = false, summary }: { rows: ExploreRow[]; collapsible?: boolean; summary?: (n: number) => string }) {
  const [open, setOpen] = useState(false);
  const collapsed = collapsible && rows.length > GROUP_THRESHOLD && !open;
  if (collapsed && summary) {
    return (
      <ul className="mt-1 divide-y divide-border/70">
        <li className="py-3" data-explore-group-collapsed="true">
          <p className="text-[15px] leading-relaxed">{summary(rows.length)}</p>
          <button type="button" className={`mt-1 ${TOGGLE}`} aria-expanded={false} onClick={() => setOpen(true)} data-testid="show-rows">
            Show all {rows.length}
          </button>
        </li>
      </ul>
    );
  }
  return (
    <ul className="mt-1 divide-y divide-border/70">
      {rows.map((row) => (
        <ConditionRow key={`${row.group}:${row.variableId}`} row={row} />
      ))}
      {collapsible && rows.length > GROUP_THRESHOLD ? (
        <li className="py-2">
          <button type="button" className={TOGGLE} aria-expanded={true} onClick={() => setOpen(false)}>
            Show fewer
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section data-explore-question={title}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="mt-2 text-[15px] text-muted">{children}</p>;

/** The recorded times: every occurrence and contrast date with its markers, nearby events, and the event-window convention. Hidden until asked. */
function RecordedTimes({ r, model }: { r: CrossContext; model: SystemModel }) {
  const fmtExtent = (s: CrossContext["occurrences"][number]) => (s.application.text ? s.application.text : s.application.start === s.application.end ? dayMonthYear(s.application.start) : `${dayMonthYear(s.application.start)} to ${dayMonthYear(s.application.end)}`);
  return (
    <div className="mt-3 space-y-3 text-sm" data-testid="recorded-times">
      <div>
        <p className="text-muted">Recorded at {formatValue(r.pattern.repeatedValue, r.unit)}:</p>
        <ul className="mt-1 space-y-0.5">
          {r.occurrences.map((s) => (
            <li key={s.application.start}>
              {fmtExtent(s)}
              {s.application.kind === "approx" ? <span className="text-muted"> · approximate</span> : null}
              {s.application.kind === "range" ? <span className="text-muted"> · stated period</span> : null}
              {s.eventsNear.length > 0 ? <span className="text-muted"> · events nearby: {s.eventsNear.map((e) => e.title).join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-muted">Recorded at other values:</p>
        {r.contrasts.length === 0 ? (
          <p className="mt-1 text-muted">None in this period.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {r.contrasts.map((s) => (
              <li key={s.application.start}>
                {fmtExtent(s)} · {formatValue(s.patternValue, r.unit)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-muted">
        {subjectLabelFor(model, r.pattern.subjectId)} · {monthYear(r.pattern.interval.from)} → {monthYear(r.pattern.interval.to)} · events counted within {r.window.days} days of an occurrence (a display convention). A repeated record does not show that the value held between the dates.
      </p>
    </div>
  );
}

function Explanations({ r, model, domain }: { r: CrossContext; model: SystemModel; domain: DomainDefinition }) {
  const ids = useId();
  const router = useRouter();
  const { proposals, proposalRecovery } = useModel();
  // drafts are keyed by the FULL pattern reference (interval included): a wider
  // evidence window has different contrast cases and is a different investigation
  const scope = `${model.id}|${encodePatternRef(r.pattern)}`;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<{ locus: Locus; text: string; promptId?: string } | null>(null);
  const [ledger, setLedger] = useState<MutationProposal[] | null>(null);
  const [busyDraft, setBusyDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [openHyp, setOpenHyp] = useState<string | null>(null);
  const investigateReady = proposals !== null && proposalRecovery.status === "done";

  useEffect(() => {
    // localStorage is a per-viewer convenience: read once per pattern in an effect, never during render
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(readDrafts(scope));
  }, [scope]);

  // Reconcile drafts that reference a proposal from the ledger: open ones stay
  // linked, superseded ones follow their replacement, applied or rejected ones
  // may leave browser storage. Creation alone never removes a draft.
  useEffect(() => {
    if (!investigateReady || !proposals) return;
    let cancelled = false;
    void proposals.list(model.id).then((all) => {
      if (cancelled) return;
      setLedger(all);
      const byId = new Map(all.map((p) => [p.id, p]));
      const current = readDrafts(scope);
      let changed = false;
      const next: Draft[] = [];
      for (const d of current) {
        if (!d.proposalId) {
          next.push(d);
          continue;
        }
        const rec = reconcileDraft(d.proposalId, (id) => byId.get(id) ?? null);
        if (rec.action === "remove") changed = true;
        else if (rec.action === "relink") {
          next.push({ ...d, proposalId: rec.proposalId });
          changed = true;
        } else if (rec.action === "unlink") {
          const { proposalId: _gone, ...rest } = d;
          void _gone;
          next.push(rest);
          changed = true;
        } else next.push(d);
      }
      if (changed) {
        writeDrafts(scope, next);
        setDrafts(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [investigateReady, proposals, model.id, scope]);

  const save = (next: Draft[]) => {
    setDrafts(next);
    writeDrafts(scope, next);
  };
  const statusOf = (d: Draft) => (d.proposalId ? (ledger?.find((p) => p.id === d.proposalId)?.status ?? null) : null);

  /** Investigate = create ONE proposal for this draft, then go review it. Never a model write. */
  const investigate = async (d: Draft) => {
    if (!proposals || !investigateReady) return;
    if (d.proposalId) {
      router.push(`/proposals?focus=${encodeURIComponent(d.proposalId)}`);
      return;
    }
    setBusyDraft(d.id);
    setProblem(null);
    try {
      const input = buildExploreProposal(d, r, domain);
      const created = await proposals.create({ modelId: model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis });
      save(drafts.map((x) => (x.id === d.id ? { ...x, proposalId: created.id } : x)));
      router.push(`/proposals?focus=${encodeURIComponent(created.id)}`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyDraft(null);
    }
  };

  const linked = linkedHypotheses(model, r.pattern.variableId);
  const related = mergeRelated(linked, ledger ? createdFromPattern(ledger, r.pattern, model.hypotheses) : []);
  const prompts = domain.explanationCatalogue?.prompts ?? [];
  const linkWords: Record<string, string> = {
    prediction: "a prediction names this record",
    kill_criterion: "a decision rule names this record",
    relationship: "a linked relationship touches this record",
    supporting_observation: "a supporting observation names this record",
    contradicting_observation: "a contradicting observation names this record",
    observation_link: "an observation links both",
  };

  return (
    <div className="mt-2 space-y-6">
      {related.length > 0 ? (
        <div data-testid="already-investigating">
          <p className="text-sm text-muted">Already investigating</p>
          <ul className="mt-1 divide-y divide-border/70">
            {related.map(({ hypothesis, linkedVia, createdFromThisPattern }) => (
              <li key={hypothesis.id} className="py-3" data-hypothesis-id={hypothesis.id}>
                <p className="text-[15px] leading-relaxed">
                  <Link href="/hypotheses" className="hover:underline">
                    “{hypothesis.statement}”
                  </Link>
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                  {createdFromThisPattern ? <span data-testid="created-from-pattern">Created from this pattern</span> : null}
                  <button type="button" className={TOGGLE} aria-expanded={openHyp === hypothesis.id} onClick={() => setOpenHyp((x) => (x === hypothesis.id ? null : hypothesis.id))}>
                    {openHyp === hypothesis.id ? "Hide details" : "Details"}
                  </button>
                </div>
                {openHyp === hypothesis.id ? (
                  <p className="mt-1 text-sm text-muted" data-testid="hypothesis-details">
                    Status: {hypothesis.status}. Confidence: {hypothesis.confidence === null ? "not assessed" : `${Math.round(hypothesis.confidence * 100)}%`}.{linkedVia.length > 0 ? ` Linked because ${linkedVia.map((v) => linkWords[v]).join("; ")}.` : ""} Linked by explicit records, never by wording; a link does not mean this hypothesis explains the pattern.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {drafts.length > 0 ? (
        <ul className="divide-y divide-border/70" data-testid="drafts">
          {drafts.map((d) => {
            const st = statusOf(d);
            return (
              <li key={d.id} className="py-3" data-draft-id={d.id} data-proposal-id={d.proposalId ?? ""}>
                <p className="text-sm text-muted">{locusLabel(domain, d.locus)}</p>
                <p className="text-[15px] leading-relaxed">“{d.text}”</p>
                {d.promptId ? <p className="text-sm text-muted">From the question: {prompts.find((p) => p.id === d.promptId)?.question}</p> : null}
                {d.proposalId ? <p className="mt-1 text-sm text-muted">{proposalStatusLine(st)}</p> : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {d.proposalId ? (
                    <button type="button" className={ACTION} disabled={!investigateReady || busyDraft !== null} title={investigateReady ? undefined : INVESTIGATE_UNAVAILABLE_TEXT} onClick={() => void investigate(d)}>
                      Review proposal →
                    </button>
                  ) : (
                    <button type="button" className={PRIMARY} disabled={!investigateReady || busyDraft !== null} title={investigateReady ? undefined : INVESTIGATE_UNAVAILABLE_TEXT} aria-describedby={`${ids}-investigate`} onClick={() => void investigate(d)}>
                      {busyDraft === d.id ? "Proposing…" : "Investigate this explanation"}
                    </button>
                  )}
                  <button type="button" className={TOGGLE} onClick={() => save(drafts.filter((x) => x.id !== d.id))} disabled={busyDraft !== null}>
                    Remove draft
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {editing ? (
        <div className="rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="draft-editor">
          {editing.promptId ? <p className="mb-2 text-sm text-muted">{prompts.find((p) => p.id === editing.promptId)?.question}</p> : null}
          <label htmlFor={`${ids}-draft`} className="block text-[15px] font-medium">
            Your explanation
          </label>
          <textarea id={`${ids}-draft`} className="mt-2 block w-full resize-none rounded-xl border border-border/70 bg-surface px-4 py-3 text-[15px] leading-relaxed focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20" rows={3} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} placeholder="A condition you want to test, not a verdict about anyone." />
          <label htmlFor={`${ids}-locus`} className="mt-3 block text-sm text-muted">
            This is mostly about
          </label>
          <select id={`${ids}-locus`} className="mt-1" value={editing.locus} onChange={(e) => setEditing({ ...editing, locus: e.target.value as Locus })}>
            {LOCI.map((l) => (
              <option key={l} value={l}>
                {locusLabel(domain, l)}
              </option>
            ))}
          </select>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              className={PRIMARY}
              disabled={editing.text.trim().length === 0}
              onClick={() => {
                save([...drafts, { id: `d_${Date.now().toString(36)}`, locus: editing.locus, text: editing.text.trim(), promptId: editing.promptId }]);
                setEditing(null);
              }}
            >
              Keep as draft
            </button>
            <button type="button" className={TOGGLE} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <span className="text-sm text-muted">Draft only · kept in this browser</span>
          </div>
        </div>
      ) : (
        <div>
          {drafts.length === 0 && related.length === 0 ? <p className="text-[15px] leading-relaxed text-muted">Write an explanation you want to investigate.</p> : null}
          <button type="button" className={`${drafts.length === 0 && related.length === 0 ? "mt-2 " : ""}${PRIMARY}`} onClick={() => setEditing({ locus: LOCI[0], text: "" })} data-testid="write-explanation">
            Write an explanation
          </button>
        </div>
      )}

      {prompts.length > 0 ? (
        <details className="text-sm" data-testid="questions">
          <summary className="cursor-pointer text-muted hover:text-foreground">Questions to help you think</summary>
          <ul className="mt-2 divide-y divide-border/70">
            {prompts.map((q) => (
              <li key={q.id} className="py-2.5" data-prompt-id={q.id}>
                <p className="text-sm text-muted">{locusLabel(domain, q.locus)}</p>
                <p className="text-[15px] leading-relaxed">
                  {q.question}
                  {q.hint ? <span className="text-sm text-muted"> ({q.hint})</span> : null}
                </p>
                <button type="button" className={`mt-1 ${TOGGLE}`} onClick={() => setEditing({ locus: q.locus, text: "", promptId: q.id })}>
                  Write an explanation from this
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {problem ? (
        <p className="text-sm text-warn" role="alert">
          {problem}
        </p>
      ) : null}

      <HelpMeThink r={r} model={model} ledger={ledger} ready={investigateReady} />
      <p id={`${ids}-investigate`} className="text-sm text-muted">
        {investigateReady ? INVESTIGATE_TEXT : proposalRecovery.status === "error" ? `${INVESTIGATE_UNAVAILABLE_TEXT} ${proposalRecovery.message}` : INVESTIGATE_UNAVAILABLE_TEXT}
      </p>
    </div>
  );
}

/**
 * "Help me think about this pattern" (Step 7A): the configured task
 * provider answers suggest_explanations_for_pattern over the exact
 * PatternRef shown, only on the person's tap and never before the boundary
 * has been shown once in this browser. Candidates stay possibilities with
 * their basis in words; "Review as hypothesis" is the 5D bridge unchanged:
 * ONE addHypothesis proposal the person submits and decides on in Review.
 * The model is byte-unchanged until approval there.
 */
function HelpMeThink({ r, model, ledger, ready }: { r: CrossContext; model: SystemModel; ledger: MutationProposal[] | null; ready: boolean }) {
  const router = useRouter();
  const { proposals } = useModel();
  const [thinking, setThinking] = useState<ExploreThinking | null>(null);
  const [busy, setBusy] = useState(false);
  const [disclosing, setDisclosing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    // the boundary acknowledgement is a per-browser convenience, read once
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcknowledged(readConsent());
  }, []);
  const current = useMemo(() => exploreContext(model, r.pattern), [model, r.pattern]);
  const shown = visibleThinking(thinking, current);
  const payloadHref = `/ai?task=suggest_explanations_for_pattern&${encodePatternRef(r.pattern)}`;

  const run = async (ctx: AiContext) => {
    setBusy(true);
    try {
      const result = await createTaskProvider(KIND).run(providerPayload(ctx), ctx.contextHash);
      setThinking({ forHash: ctx.contextHash, result });
    } finally {
      setBusy(false);
    }
  };
  const help = async () => {
    if (!("ctx" in current) || busy) return;
    if (needsDisclosure(KIND, acknowledged)) {
      setDisclosing(true);
      return;
    }
    await run(current.ctx);
  };
  const confirm = async () => {
    writeConsent();
    setAcknowledged(true);
    setDisclosing(false);
    if ("ctx" in current) await run(current.ctx);
  };
  const bridge = shown && shown.ok && "ctx" in current ? toProposalSet(current.ctx, shown.response, ADAPTER_IDS[KIND]) : null;
  const items = "ctx" in current ? current.ctx.items : [];
  /** The person submits; the AI output is recorded as origin only. Never a model write. */
  const reviewAsHypothesis = async (candidate: AiProposalCandidate) => {
    if (!proposals || !ready) return;
    const existing = suggestionState(ledger ?? [], candidate.identity);
    if (existing.state === "open") {
      router.push(`/proposals?focus=${encodeURIComponent(existing.proposal.id)}`);
      return;
    }
    if (existing.state !== "none") return;
    setSubmitting(candidate.identity.outputItemId);
    setProblem(null);
    try {
      const created = await proposals.create({ modelId: model.id, request: candidate.request, proposedBy: { kind: "person" }, rationale: candidate.rationale, basis: candidate.basis });
      router.push(`/proposals?focus=${encodeURIComponent(created.id)}`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(null);
    }
  };
  const badge = providerBadge(KIND);

  return (
    <div className="mt-2">
      <p className="text-sm">
        <button type="button" className="inline-flex items-center gap-2 text-muted hover:underline disabled:opacity-60" disabled={busy || "error" in current} onClick={() => void help()} data-testid="help-me-think">
          {busy ? "Thinking…" : "Help me think about this pattern"}
          {badge ? <span className="rounded-full border border-border px-1.5 py-0.5 text-xs">{badge}</span> : null}
        </button>
      </p>
      {"error" in current ? <p className="mt-1 text-sm text-muted">{current.error}</p> : null}
      {disclosing && "ctx" in current ? <AiDisclosure sentence={DISCLOSURE_PATTERN} lines={sharedLines(current.ctx.manifest)} payloadHref={payloadHref} busy={busy} onConfirm={() => void confirm()} onCancel={() => setDisclosing(false)} /> : null}
      {shown ? (
        shown.ok ? (
          <section className="mt-3 rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="thinking">
            <p className="text-sm text-muted">{KIND === "mock" ? "Demo response" : "Possibilities to consider"}</p>
            {bridge && !bridge.ok ? <Note tone="warn">These possibilities cannot be reviewed as a proposal: {bridge.error}</Note> : null}
            <div className="mt-2 space-y-4 text-[15px] leading-relaxed">
              {shown.response.items.map((it) => {
                if (it.kind === "candidate_explanation") {
                  const candidate = bridge && bridge.ok ? bridge.set.candidates.find((c) => c.identity.outputItemId === it.id) : undefined;
                  const existing: SuggestionState = candidate ? suggestionState(ledger ?? [], candidate.identity) : { state: "none" };
                  const rests = citedLabels([it.forPattern, ...it.restsOn], items);
                  return (
                    <div key={it.id} data-thinking-kind="possibility">
                      <p>{it.text}</p>
                      <p className="mt-1 text-sm text-muted">{stateWords(it.state)}</p>
                      {rests.length ? <p className="mt-1 text-sm text-muted">Rests on {rests.join("; ")}.</p> : null}
                      {it.weakenedBy.length ? <p className="mt-1 text-sm text-muted">Would be weakened by: {it.weakenedBy.join(" · ")}</p> : null}
                      {it.alternatives.length ? <p className="mt-1 text-sm text-muted">Other readings: {it.alternatives.join(" · ")}</p> : null}
                      {candidate ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2" data-suggestion={candidate.identity.outputItemId}>
                          {existing.state === "applied" ? (
                            <span className="text-sm text-muted">
                              Already added as a working explanation ·{" "}
                              <Link href={`/proposals?focus=${encodeURIComponent(existing.proposal.id)}`} className="underline">
                                see the decision
                              </Link>
                            </span>
                          ) : existing.state === "rejected" ? (
                            <span className="text-sm text-muted">
                              Rejected earlier ·{" "}
                              <Link href={`/proposals?focus=${encodeURIComponent(existing.proposal.id)}`} className="underline">
                                see it
                              </Link>
                            </span>
                          ) : (
                            <button type="button" className={ACTION} disabled={!ready || submitting !== null} title={ready ? undefined : INVESTIGATE_UNAVAILABLE_TEXT} onClick={() => void reviewAsHypothesis(candidate)}>
                              {existing.state === "open" ? "Review proposal" : "Review as hypothesis"}
                            </button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                }
                if (it.kind === "question") {
                  return (
                    <p key={it.id} data-thinking-kind="question">
                      <span className="block text-sm text-muted">Question worth answering</span>
                      {it.text}
                      <span className="mt-1 block text-sm text-muted">{it.whyItMatters}</span>
                    </p>
                  );
                }
                return null;
              })}
              {shown.response.items.length === 0 ? <p className="text-muted">{KIND === "mock" ? "The demo has nothing to say about this pattern." : "Nothing came back for this pattern."}</p> : null}
            </div>
            {problem ? (
              <p className="mt-2 text-sm text-warn" role="alert">
                {problem}
              </p>
            ) : null}
            <p className="mt-3 text-sm text-muted">Reviewing a possibility creates a proposal you decide on in Review; nothing is added until you approve it there.</p>
            <Link href={payloadHref} className="mt-1 inline-block text-sm text-muted underline">
              {KIND === "mock" ? "See exactly what a real assistant would receive" : "See exactly what was sent"}
            </Link>
          </section>
        ) : (
          <AiFailure line={THINKING_FAILED} detail={shown.error} />
        )
      ) : null}
    </div>
  );
}

function ExploreBody({ pattern, model, domain }: { pattern: PatternRef; model: SystemModel; domain: DomainDefinition }) {
  // context scope is domain configuration (a household reads its members for a household-level pattern); the math is unchanged
  const result = useMemo(() => crossContext(model, pattern, { contextSubjectIds: contextSubjectsFor(model, pattern, domain) }), [model, pattern, domain]);
  const [timesOpen, setTimesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // back to History with the same period the pattern was found in (the reference carries it; nothing else is invented)
  const back = `/history?${new URLSearchParams({ from: pattern.interval.from, to: pattern.interval.to }).toString()}`;
  const sections = useMemo(() => (result.ok ? exploreSections(result) : null), [result]);
  if (!result.ok || !sections) {
    return (
      <div className="space-y-3">
        <Note tone="warn">{result.ok ? "" : result.message}</Note>
        <Link href={back} className="text-sm underline">
          Back to History
        </Link>
      </div>
    );
  }
  const r = result;
  return (
    <div>
      <header className="mb-8">
        <Link href={back} className="text-sm text-muted hover:underline" data-testid="back-to-history">
          ← Back to History
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">Explore</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">This kept happening. Why might that be?</p>
        <p className="mt-4 text-[17px] font-medium leading-snug" data-testid="pattern">
          {sections.pattern}
        </p>
        <button type="button" className={`mt-2 ${TOGGLE}`} aria-expanded={timesOpen} onClick={() => setTimesOpen((x) => !x)} data-testid="recorded-times-toggle">
          {timesOpen ? "Hide the recorded times" : "See the recorded times"}
        </button>
        {timesOpen ? <RecordedTimes r={r} model={model} /> : null}
      </header>

      <div className="space-y-10">
        <Question title="What was different each time?">{sections.different.length === 0 ? <Empty>Nothing recorded changed between these times.</Empty> : <Rows rows={sections.different} collapsible summary={(n) => `${n} conditions were recorded at different values across these times.`} />}</Question>

        <Question title="What was the same each time?">{sections.same.length === 0 ? <Empty>Nothing readable was recorded the same at every one of these times.</Empty> : <Rows rows={sections.same} collapsible summary={(n) => `${n} conditions were recorded at the same value every time.`} />}</Question>

        <Question title="How did the other recorded times compare?">
          {r.contrasts.length === 0 ? (
            <Empty>{NO_CONTRASTS_YET}</Empty>
          ) : sections.compared.length === 0 ? (
            <Empty>No condition recorded the same each time can be compared completely with the other recorded times yet.</Empty>
          ) : (
            <div className="mt-2 space-y-5">
              {sections.compared.map((g) => (
                <div key={g.group} data-contrast-group={g.group}>
                  <p className="text-sm font-medium text-muted">{g.heading}</p>
                  <Rows rows={g.rows} collapsible summary={(n) => `${n} conditions. ${g.heading}.`} />
                </div>
              ))}
            </div>
          )}
        </Question>

        <Question title="What is still unresolved?">{sections.unresolved.length === 0 ? <Empty>Nothing is unresolved for this pattern.</Empty> : <Rows rows={sections.unresolved} collapsible summary={(n) => `${n} conditions cannot be compared yet: missing, conflicting, or read only in part.`} />}</Question>

        <Question title="What might explain this?">
          <Explanations r={r} model={model} domain={domain} />
        </Question>
      </div>

      <footer className="mt-12 space-y-2 text-sm text-muted">
        <p>{EXPLORE_CAVEAT}</p>
        <button type="button" className={TOGGLE} aria-expanded={aboutOpen} onClick={() => setAboutOpen((x) => !x)} data-testid="about">
          {aboutOpen ? "Hide" : "About this comparison"}
        </button>
        {aboutOpen ? (
          <ul className="list-disc space-y-1 pl-5" data-testid="about-details">
            <li>{CAUSATION_DISCLAIMER}</li>
            <li>“The same each time” means recorded at the same value at every one of these times. A value only carried forward by the resolver never counts, and recorded together is not caused by.</li>
            <li>“How did the other recorded times compare?” lists only conditions with complete contrast coverage; an incomplete comparison stays under “still unresolved” and is never promoted. True in both cases is not the difference.</li>
            <li>Unresolved covers five different things, each said as it is: missing, conflicting for the same time, varied within a broad period, only an older value standing, and contrast evidence incomplete.</li>
            <li>An explanation is a condition to test, never a verdict. A draft is a candidate, not evidence.</li>
            {r.caveats.map((c) => (
              <li key={c.code}>{c.text}</li>
            ))}
          </ul>
        ) : null}
      </footer>
    </div>
  );
}

function ExploreInner() {
  const { status, model, evaluated, error } = useModel();
  const params = useSearchParams();
  const pattern = useMemo(() => decodePatternRef(new URLSearchParams(params.toString())), [params]);
  if (status === "error") return <Note tone="warn">Could not load the model: {error}</Note>;
  if (status === "loading" || !model || !evaluated) return <Loading />;
  return (
    <div className="mx-auto max-w-2xl">
      {pattern === null ? (
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Explore</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">Open something that keeps showing up in History to explore it: every pattern here starts from a value recorded more than once.</p>
          <Link href="/history" className="mt-4 inline-block text-[15px] font-medium text-accent hover:underline">
            Go to History →
          </Link>
        </div>
      ) : (
        <ExploreBody pattern={pattern} model={model} domain={evaluated.domain} />
      )}
    </div>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={<Loading />}>
      <ExploreInner />
    </Suspense>
  );
}
