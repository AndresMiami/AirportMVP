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
 * Home invents no analysis. "Reflect on this" (Demo) runs the deterministic
 * task mock through the 5B/5C context and output contracts, read-only, and
 * says so. Absence renders nothing: no empty-state cards.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildAiContext, providerPayload } from "@/ai/context";
import type { AiOutputItem } from "@/ai/response";
import { MockAiTaskProvider } from "@/ai/task-mock";
import { useModel } from "@/components/model-provider";
import { Loading, Note } from "@/components/ui";
import { openProposalCount, recurrenceOverview, workingHypotheses } from "@/features/home/cards";
import type { MutationProposal } from "@/kernel";

const DRAFT_KEY = "human-systems.home-draft.v1";

function readDraft(modelId: string): string {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, string>;
    return typeof all[modelId] === "string" ? all[modelId] : "";
  } catch {
    return "";
  }
}
function writeDraft(modelId: string, text: string): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, string>;
    all[modelId] = text;
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the draft lives for this page only */
  }
}
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
  const { status, model, evaluated, proposals, proposalRecovery, asOf, isSample, seedLabel } = useModel();
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [ledger, setLedger] = useState<MutationProposal[] | null>(null);
  const [reflection, setReflection] = useState<{ ok: true; items: AiOutputItem[] } | { ok: false; error: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const today = todayIso();

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

  if (status === "error") return null; // the storage notice above says what happened
  if (status === "loading" || !model || !evaluated) return <Loading />;

  const open = ledger ? openProposalCount(ledger) : null;
  const working = workingHypotheses(model);
  const hasText = draft.trim().length > 0;
  const update = (text: string) => {
    setDraft(text);
    writeDraft(model.id, text);
    setReflection(null);
  };
  const reflect = async () => {
    try {
      const ctx = buildAiContext(model, "interpret_free_text", { subjectId: model.id, userText: draft, asOf: asOf ? asOf.slice(0, 10) : today });
      const r = await new MockAiTaskProvider().run(providerPayload(ctx), ctx.contextHash);
      setReflection(r.ok ? { ok: true, items: r.response.items } : { ok: false, error: r.error });
    } catch (e) {
      setReflection({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

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
            <button type="button" className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90" onClick={() => void reflect()}>
              Reflect on this
              <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-xs font-medium">Demo</span>
            </button>
            <span className="text-sm text-muted">Demo response · nothing is saved to your notebook.</span>
          </div>
        ) : null}
        {reflection ? (
          reflection.ok ? (
            <div className="mt-4 rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="reflection">
              <p className="text-sm text-muted">Demo response</p>
              <ul className="mt-2 space-y-2 text-[15px] leading-relaxed">
                {reflection.items.map((it) => (
                  <li key={it.id}>
                    {it.kind === "interpretation" ? (
                      <>
                        <span className="text-muted">A tentative reading:</span> {it.text}
                        {it.caveat ? <span className="block text-sm text-muted">{it.caveat}</span> : null}
                      </>
                    ) : it.kind === "question" ? (
                      <>
                        <span className="text-muted">A question:</span> {it.text}
                      </>
                    ) : (
                      it.kind
                    )}
                  </li>
                ))}
                {reflection.items.length === 0 ? <li className="text-muted">The demo has nothing to say about this yet.</li> : null}
              </ul>
              <Link href="/ai" className="mt-2 inline-block text-sm text-muted underline">
                See exactly what a real assistant would receive
              </Link>
            </div>
          ) : (
            <Note tone="warn">{reflection.error}</Note>
          )
        ) : null}
      </section>

      <div className="space-y-6">
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
              View all →
            </Link>
          </section>
        ) : null}
      </div>

      <p className="mt-14 text-sm text-muted">
        {isSample ? <>You are looking at the {seedLabel}. </> : null}
        Your own system, and everything underneath, is in{" "}
        <Link href="/library" className="underline">
          Library
        </Link>
        .
      </p>
    </div>
  );
}
