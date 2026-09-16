"use client";
/**
 * HOME (Step 6A): a calm notebook over the whole machine.
 *
 *   What are you thinking about?   -> a browser-local draft (never the model)
 *   Something keeps showing up     -> the deterministic History engine
 *   Needs your review              -> the proposal ledger
 *   Working explanations           -> the canonical hypotheses
 *
 * Home invents no analysis. "Reflection demo" runs the deterministic task
 * mock through the 5B/5C context and output contracts, read-only, and says
 * so. Home = meaning; a card's detail = evidence; Library = machinery.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { buildAiContext, providerPayload } from "@/ai/context";
import type { AiOutputItem } from "@/ai/response";
import { MockAiTaskProvider } from "@/ai/task-mock";
import { useModel } from "@/components/model-provider";
import { Loading, Note } from "@/components/ui";
import { openProposalCount, recurrenceCards, workingHypotheses } from "@/features/home/cards";
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

function HomeCard({ eyebrow, title, children, action, tone = "neutral" }: { eyebrow: string; title: string; children?: React.ReactNode; action: { href: string; label: string }; tone?: "neutral" | "attention" }) {
  return (
    <section className={`rounded-2xl bg-surface px-5 py-4 shadow-sm ${tone === "attention" ? "ring-1 ring-warn/40" : ""}`} data-home-card={eyebrow}>
      <p className="text-xs uppercase tracking-wide text-muted">{eyebrow}</p>
      <h2 className="mt-1 text-base font-medium leading-snug">{title}</h2>
      {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      <Link href={action.href} className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
        {action.label} →
      </Link>
    </section>
  );
}

export default function HomePage() {
  const { status, model, evaluated, proposals, proposalRecovery, asOf, setAsOf, isSample, seedLabel } = useModel();
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [ledger, setLedger] = useState<MutationProposal[] | null>(null);
  const [reflection, setReflection] = useState<{ ok: true; items: AiOutputItem[] } | { ok: false; error: string } | null>(null);
  const today = todayIso();

  useEffect(() => {
    if (!model || loaded === model.id) return;
    // the draft is a per-viewer convenience in this browser, never model state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(readDraft(model.id));
    setLoaded(model.id);
  }, [model, loaded]);

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

  const cards = useMemo(() => (model ? recurrenceCards(model, asOf ? asOf.slice(0, 10) : today) : []), [model, asOf, today]);

  if (status === "error") return null; // the storage notice above says what happened
  if (status === "loading" || !model || !evaluated) return <Loading />;

  const open = ledger ? openProposalCount(ledger) : null;
  const working = workingHypotheses(model);
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
      {asOf ? (
        <div className="mb-5 rounded-2xl bg-warn-soft px-5 py-3 text-sm" role="status">
          You are looking at values as of <span className="font-medium tabular-nums">{asOf.slice(0, 10)}</span>. Anything not recorded by then shows as unknown.{" "}
          <button type="button" className="underline" onClick={() => setAsOf(null)}>
            Back to today
          </button>
        </div>
      ) : null}
      {isSample ? <p className="mb-5 text-xs text-muted">You are looking at the {seedLabel}. Your own system can be created in Library.</p> : null}

      <section className="mb-8">
        <label htmlFor="home-thinking" className="block text-2xl font-semibold tracking-tight md:text-3xl">
          What are you thinking about?
        </label>
        <p className="mt-2 text-sm text-muted">Write what&apos;s on your mind. You don&apos;t need to organize it first.</p>
        <div className="relative mt-4">
          <textarea id="home-thinking" className="w-full resize-y rounded-2xl border-0 bg-surface px-5 py-4 text-base leading-relaxed shadow-sm focus:outline-none focus:ring-2 focus:ring-accent/40" rows={6} value={draft} onChange={(e) => update(e.target.value)} placeholder="Something changed at work this month and I keep coming back to it…" />
          <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-background px-2 py-1 text-xs text-muted" title="Voice input is not available yet" aria-hidden="true">
            🎤
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={draft.trim().length === 0} onClick={() => void reflect()}>
            Reflection demo
          </button>
          <span className="text-xs text-muted">Kept in this browser until you ask the app to work with it. The demo is a deterministic stand-in, not real intelligence.</span>
        </div>
        {reflection ? (
          reflection.ok ? (
            <div className="mt-4 rounded-2xl bg-surface px-5 py-4 shadow-sm" data-testid="reflection">
              <p className="text-xs uppercase tracking-wide text-muted">Reflection demo · nothing is added to your notebook</p>
              <ul className="mt-2 space-y-2 text-sm">
                {reflection.items.map((it) => (
                  <li key={it.id}>
                    {it.kind === "interpretation" ? (
                      <>
                        <span className="text-muted">A tentative reading:</span> {it.text}
                        {it.caveat ? <span className="block text-xs text-muted">{it.caveat}</span> : null}
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
              <Link href="/ai" className="mt-2 inline-block text-xs text-muted underline">
                See exactly what a real assistant would receive
              </Link>
            </div>
          ) : (
            <Note tone="warn">{reflection.error}</Note>
          )
        ) : null}
      </section>

      <div className="space-y-4">
        {cards.length > 0 ? (
          cards.map((c) => (
            <HomeCard key={c.variableId} eyebrow="Something keeps showing up" title={c.headline} action={{ href: c.exploreHref, label: "Explore" }}>
              {c.details[0]}
            </HomeCard>
          ))
        ) : (
          <HomeCard eyebrow="Something keeps showing up" title="Nothing has repeated in the records yet." action={{ href: "/history", label: "See what changed" }}>
            A record has to be entered again at a later date before anything can keep showing up.
          </HomeCard>
        )}

        {proposalRecovery.status === "error" ? (
          <Note tone="warn">Your proposals could not be read: {proposalRecovery.message}</Note>
        ) : open !== null && open > 0 ? (
          <HomeCard eyebrow="Needs your review" title={open === 1 ? "1 proposed change is waiting for you." : `${open} proposed changes are waiting for you.`} action={{ href: "/proposals", label: "Review" }} tone="attention">
            Nothing changes in your notebook until you decide.
          </HomeCard>
        ) : (
          <HomeCard eyebrow="Needs your review" title="Nothing is waiting for your decision." action={{ href: "/proposals", label: "See past decisions" }} />
        )}

        {working.length > 0 ? (
          <HomeCard eyebrow="Working explanations" title={working.length === 1 ? "1 explanation you're currently investigating." : `${working.length} explanations you're currently investigating.`} action={{ href: "/hypotheses", label: "View" }}>
            {working.slice(0, 2).map((h) => `“${h.statement}”`).join(" · ")}
            {working.length > 2 ? " · …" : ""}
          </HomeCard>
        ) : (
          <HomeCard eyebrow="Working explanations" title="You're not investigating anything yet." action={{ href: "/history", label: "Start from what keeps showing up" }}>
            An explanation begins as something to test, never as a conclusion.
          </HomeCard>
        )}
      </div>

      <p className="mt-10 text-xs text-muted">
        Everything underneath is available in{" "}
        <Link href="/library" className="underline">
          Library
        </Link>
        .
      </p>
    </div>
  );
}
