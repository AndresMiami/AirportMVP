"use client";
/**
 * HOME (Step 6A, converged visually in 6A.1): the notebook is the product;
 * analysis appears only when there is something worth noticing.
 *
 *   What are you thinking about?   -> a browser-local draft (never the model)
 *   Something keeps showing up     -> ONE strongest repetition from the
 *                                     deterministic History engine, worded
 *                                     for Home; the rest is a count
 *   Needs your review              -> the proposal ledger, only when open
 *   Working explanations           -> the canonical hypotheses, only when any
 *
 * Home invents no analysis. "Reflect on this" runs the CONFIGURED task
 * provider (Step 7A: the real reflection service when the site is built
 * with NEXT_PUBLIC_AI_PROVIDER=remote, the deterministic demo otherwise)
 * through the 5B/5C context and output contracts, read-only, only on the
 * person's tap, and never before the boundary has been shown once in this
 * browser; the result is bound to the contextHash it answered and hides the
 * moment the model, the date or the text changes that context (6A.1.1).
 * A failed call is one calm line with its safe category behind Details;
 * nothing is retried, nothing is written. Absence renders nothing: no
 * empty-state cards.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { providerPayload, type AiContext } from "@/ai/context";
import { CONFIGURED_PROVIDER_KIND, createTaskProvider } from "@/ai/task-select";
import { AiDisclosure, AiFailure } from "@/components/ai-boundary";
import { useModel } from "@/components/model-provider";
import { Loading, Note } from "@/components/ui";
import { readConsent, writeConsent } from "@/features/ai/consent";
import { DISCLOSURE_NOTE, NOTHING_SAVED, REFLECTION_FAILED, needsDisclosure, providerBadge, responseHeading, sharedLines } from "@/features/ai/wording";
import { openProposalCount, recurrenceOverview, workingHypotheses } from "@/features/home/cards";
import { readDraft, writeDraft } from "@/features/home/draft";
import { homeContext, visibleReflection, type HomeReflection } from "@/features/home/reflection";
import type { MutationProposal } from "@/kernel";

const KIND = CONFIGURED_PROVIDER_KIND;
const PAYLOAD_HREF = "/ai?task=interpret_free_text&source=home-draft";
const todayIso = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const truncate = (s: string, max = 110) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** The one card Home allows real weight: a subtle surface, one label in
 *  sentence case, one sentence, one action. */
function Insight({ label, title, children, action, tone = "neutral" }: { label: string; title: string; children?: React.ReactNode; action: { href: string; label: string }; tone?: "neutral" | "attention" }) {
  return (
    <section className={`rounded-xl border bg-surface px-5 py-4 ${tone === "attention" ? "border-warn/40" : "border-border/70"}`} data-home-card={label}>
      <p className="text-sm text-muted">{label}</p>
      <h2 className="mt-1.5 text-[17px] font-medium leading-snug">{title}</h2>
      {children ? <div className="mt-1.5 text-[15px] leading-relaxed text-muted">{children}</div> : null}
      <Link href={action.href} className="mt-3 inline-block text-[15px] font-medium text-accent hover:underline">
        {action.label} →
      </Link>
    </section>
  );
}

export default function HomePage() {
  const { status, model, evaluated, proposals, proposalRecovery, asOf, isSample } = useModel();
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [ledger, setLedger] = useState<MutationProposal[] | null>(null);
  const [reflection, setReflection] = useState<HomeReflection | null>(null);
  const [busy, setBusy] = useState(false);
  const [disclosing, setDisclosing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [showShared, setShowShared] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const today = todayIso();

  useEffect(() => {
    // the boundary acknowledgement is a per-browser convenience, read once
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcknowledged(readConsent());
  }, []);

  useEffect(() => {
    if (!model || loaded === model.id) return;
    // the draft is a per-viewer convenience in this browser, never model state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(readDraft(model.id));
    setLoaded(model.id);
  }, [model, loaded]);

  // the writing surface grows with the note instead of scrolling or resizing
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 168)}px`;
  }, [draft, model]);

  useEffect(() => {
    if (!proposals || !model || proposalRecovery.status !== "done") return;
    let cancelled = false;
    void proposals.list(model.id).then((all) => {
      if (!cancelled) setLedger(all);
    });
    return () => {
      cancelled = true;
    };
  }, [proposals, model, proposalRecovery.status]);

  const patterns = useMemo(() => (model ? recurrenceOverview(model, asOf ? asOf.slice(0, 10) : today) : { strongest: null, more: 0 }), [model, asOf, today]);
  // the context the demo would answer RIGHT NOW; a stored reflection is shown only while it matches
  const current = useMemo(() => (model ? homeContext(model, draft, asOf, today) : null), [model, draft, asOf, today]);

  if (status === "error") return null; // the storage notice above says what happened
  if (status === "loading" || !model || !evaluated) return <Loading />;

  const open = ledger ? openProposalCount(ledger) : null;
  const working = workingHypotheses(model);
  const hasText = draft.trim().length > 0;
  const shown = visibleReflection(reflection, current);
  const update = (text: string) => {
    setDraft(text);
    writeDraft(model.id, text);
  };
  /** ONE call per tap, never on load, typing or navigation; the answer is bound to the hash it answered. */
  const runReflection = async (ctx: AiContext) => {
    setBusy(true);
    try {
      const r = await createTaskProvider(KIND).run(providerPayload(ctx), ctx.contextHash);
      setReflection({ forHash: ctx.contextHash, result: r.ok ? { ok: true, items: r.response.items } : { ok: false, error: r.error } });
    } finally {
      setBusy(false);
    }
  };
  const reflect = async () => {
    if (!current || "error" in current || busy) return;
    if (needsDisclosure(KIND, acknowledged)) {
      setDisclosing(true);
      return;
    }
    await runReflection(current.ctx);
  };
  const confirmDisclosure = async () => {
    writeConsent();
    setAcknowledged(true);
    setDisclosing(false);
    if (current && "ctx" in current) await runReflection(current.ctx);
  };
  const badge = providerBadge(KIND);

  return (
    <div className="mx-auto max-w-2xl">
      <section className="mb-10">
        <label htmlFor="home-thinking" className="block text-2xl font-semibold tracking-tight md:text-3xl">
          What are you thinking about?
        </label>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">Write what&apos;s on your mind. You don&apos;t need to organize it first.</p>
        <textarea ref={area} id="home-thinking" className="mt-5 block w-full resize-none overflow-hidden rounded-xl border border-border/70 bg-surface px-5 py-4 text-[17px] leading-relaxed placeholder:text-muted/70 focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20" rows={6} value={draft} onChange={(e) => update(e.target.value)} placeholder="Something changed at work this month and I keep coming back to it…" />
        {hasText ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-60" disabled={busy} onClick={() => void reflect()} data-testid="reflect">
              {busy ? "Reflecting…" : "Reflect on this"}
              {badge ? <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-xs font-medium">{badge}</span> : null}
            </button>
            {KIND === "mock" ? (
              <span className="text-sm text-muted">Demo response · nothing is saved to your notebook.</span>
            ) : (
              <span className="text-sm text-muted">
                {NOTHING_SAVED}{" "}
                <button type="button" className="underline hover:text-foreground" onClick={() => setShowShared((v) => !v)} aria-expanded={showShared} data-testid="what-is-shared-toggle">
                  What is shared
                </button>
              </span>
            )}
          </div>
        ) : null}
        {hasText && showShared && KIND === "remote" && current && "ctx" in current ? (
          <div className="mt-3 text-sm text-muted" data-testid="what-is-shared">
            <p>{DISCLOSURE_NOTE}</p>
            <ul className="mt-1 list-disc pl-5">
              {sharedLines(current.ctx.manifest).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <Link href={PAYLOAD_HREF} className="mt-1 inline-block underline">
              See the exact payload →
            </Link>
          </div>
        ) : null}
        {current && "error" in current ? <Note tone="warn">{current.error}</Note> : null}
        {disclosing && current && "ctx" in current ? <AiDisclosure sentence={DISCLOSURE_NOTE} lines={sharedLines(current.ctx.manifest)} payloadHref={PAYLOAD_HREF} busy={busy} onConfirm={() => void confirmDisclosure()} onCancel={() => setDisclosing(false)} /> : null}
        {shown ? (
          shown.ok ? (
            <div className="mt-4 rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="reflection">
              <p className="text-sm text-muted">{responseHeading(KIND)}</p>
              <div className="mt-2 space-y-3 text-[15px] leading-relaxed">
                {shown.items.map((it) =>
                  it.kind === "interpretation" ? (
                    <p key={it.id}>
                      {it.text}
                      {it.caveat ? <span className="mt-1 block text-sm text-muted">{it.caveat}</span> : null}
                    </p>
                  ) : it.kind === "question" ? (
                    <p key={it.id}>
                      <span className="block text-sm text-muted">Question to consider</span>
                      {it.text}
                    </p>
                  ) : null,
                )}
                {shown.items.length === 0 ? <p className="text-muted">{KIND === "mock" ? "The demo has nothing to say about this yet." : "Nothing came back for this note."}</p> : null}
              </div>
              {KIND === "mock" ? (
                <Link href="/ai" className="mt-3 inline-block text-sm text-muted underline">
                  See exactly what a real assistant would receive
                </Link>
              ) : (
                <Link href={PAYLOAD_HREF} className="mt-3 inline-block text-sm text-muted underline">
                  See exactly what was sent
                </Link>
              )}
            </div>
          ) : (
            <AiFailure line={REFLECTION_FAILED} detail={shown.error} />
          )
        ) : null}
      </section>

      <div className="space-y-6">
        {model.variables.length === 0 && working.length === 0 ? (
          <p className="text-[15px] leading-relaxed text-muted" data-testid="empty-notebook">
            Nothing has been recorded in this notebook yet. Keep writing here, or add records and the model in Library.
          </p>
        ) : null}
        {patterns.strongest ? (
          <div>
            <Insight label="Something keeps showing up" title={patterns.strongest.sentence} action={{ href: patterns.strongest.exploreHref, label: "Explore what was happening" }} />
            {patterns.more > 0 ? (
              <p className="mt-2 px-5 text-sm text-muted">
                <Link href="/history" className="hover:underline" data-testid="more-patterns">
                  {patterns.more === 1 ? "1 more pattern in History" : `${patterns.more} more patterns in History`} →
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}

        {proposalRecovery.status === "error" ? (
          <Note tone="warn">Your proposals could not be read: {proposalRecovery.message}</Note>
        ) : open !== null && open > 0 ? (
          <Insight label="Needs your review" title={open === 1 ? "1 proposed change is waiting for you." : `${open} proposed changes are waiting for you.`} action={{ href: "/proposals", label: "Review" }} tone="attention">
            Nothing changes in your notebook until you decide.
          </Insight>
        ) : null}

        {working.length > 0 ? (
          <section className="px-5" data-home-card="Working explanations">
            <p className="text-[15px] leading-relaxed">
              <span className="font-medium">{working.length === 1 ? "You're investigating 1 explanation" : `You're investigating ${working.length} explanations`}</span>
              <span className="block text-muted">“{truncate(working[0].statement)}”</span>
            </p>
            <Link href="/hypotheses" className="mt-1.5 inline-block text-sm font-medium text-accent hover:underline">
              All explanations →
            </Link>
          </section>
        ) : null}
      </div>

      <p className="mt-14 text-sm text-muted">
        {isSample ? <>Fictional sample · </> : null}
        Your systems and advanced details are in{" "}
        <Link href="/library" className="underline">
          Library
        </Link>
        .
      </p>
    </div>
  );
}
