"use client";
/**
 * Nine-step checklist for building a system up from blank. Each step links
 * to the screen where it is done and shows whether the model already
 * satisfies it. Display only: the checks read the stored model and the
 * evaluated system; nothing here adds data or interprets anything.
 */
import Link from "next/link";
import { useState } from "react";
import type { EvaluatedSystem } from "@/model/evaluate";
import type { SystemModel } from "@/types";

export interface SetupStep {
  id: string;
  title: string;
  href: string;
  screen: string;
  detail: string;
  done: boolean;
  /** false for the last step: it has no completion condition of its own. */
  tracked: boolean;
}

/** The nine steps, with each check computed from the model as it stands. */
export function setupSteps(model: SystemModel, evaluated: EvaluatedSystem): SetupStep[] {
  const inputVariables = model.variables.filter((v) => v.kind === "input");
  const tracked: Omit<SetupStep, "tracked">[] = [
    {
      id: "members",
      title: "Add household members",
      href: "/profile",
      screen: "System profile",
      detail: "Who the system includes. An observation can name a member as its subject.",
      done: model.profile.members.length > 0,
    },
    {
      id: "observations",
      title: "Add observations",
      href: "/observations",
      screen: "Observations",
      detail: "Things noticed or reported, kept as stated. They are evidence, never values.",
      done: model.observations.length > 0,
    },
    {
      id: "income",
      title: "Add income sources",
      href: "/income",
      screen: "Income sources",
      detail: "Each source with its own reliability, volatility and failure group. The household-level numbers are calculated from this list.",
      done: model.incomeSources.length > 0,
    },
    {
      id: "variables",
      title: "Create structural variables",
      href: "/variables",
      screen: "Structural variables",
      detail: "Values someone entered, each with a source type and a confidence. The calculated variables already exist and fill in from their inputs.",
      done: inputVariables.length > 0,
    },
    {
      id: "relationships",
      title: "Connect variables",
      href: "/feedback-map",
      screen: "Feedback map",
      detail: "Directed edges with a sign, a strength judgment and a lag.",
      done: model.relationships.length > 0,
    },
    {
      id: "desired",
      title: "Set desired states",
      href: "/desired",
      screen: "Desired state",
      detail: "A target value on any variable, meant as a floor, a ceiling or an exact point.",
      done: model.variables.some((v) => v.desiredValue !== null),
    },
    {
      id: "loops",
      title: "Identify candidate loops",
      href: "/hypotheses",
      screen: "Hypotheses",
      detail: "Loops appear once enabled edges close a cycle; each is recorded as a hypothesis with a status.",
      done: evaluated.loops.length > 0 && evaluated.loops.some((l) => l.hypothesis !== undefined),
    },
    {
      id: "gap",
      title: "Compare current vs desired",
      href: "/gap",
      screen: "Structural gap",
      detail: "The distance between current value and target for every variable that has both.",
      done: evaluated.gap.gaps.length > 0,
    },
  ];
  const ready = tracked.every((s) => s.done);
  return [
    ...tracked.map((s) => ({ ...s, tracked: true })),
    {
      id: "scenarios",
      title: "Run scenarios",
      href: "/scenarios",
      screen: "Scenario simulator",
      detail: "Structural what-ifs on the model as entered; not a prediction. Marked once the eight steps above are in place — running a scenario itself is not tracked.",
      done: ready,
      tracked: false,
    },
  ];
}

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent";

export function GettingStarted({
  model,
  evaluated,
  defaultOpen,
}: {
  model: SystemModel;
  evaluated: EvaluatedSystem;
  /** Open when the system is still empty; collapsed once data exists. */
  defaultOpen: boolean;
}) {
  const steps = setupSteps(model, evaluated);
  const done = steps.filter((s) => s.done).length;
  const [open, setOpen] = useState(defaultOpen);
  // Follow the prop when the page's emptiness changes under us (data
  // added or the system switched). Derived-state-during-render, as in
  // NumberField.
  const [prevDefault, setPrevDefault] = useState(defaultOpen);
  if (defaultOpen !== prevDefault) {
    setPrevDefault(defaultOpen);
    setOpen(defaultOpen);
  }

  return (
    <section className="rounded-lg border border-border bg-surface" aria-label="Setup progress">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{defaultOpen ? "Getting started" : "Setup progress"}</h2>
          <p className="text-xs text-muted">
            Setup progress: {done} of {steps.length}
            {defaultOpen ? " · this system has no income sources or input variables yet" : ""}
          </p>
        </div>
        <button type="button" className={BTN} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide steps" : "Show steps"}
        </button>
      </div>
      {open ? (
        <ol className="border-t border-border divide-y divide-border">
          {steps.map((s, i) => (
            <li key={s.id} className="flex gap-3 px-4 py-2.5">
              <span
                aria-hidden="true"
                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums ${
                  s.done ? "bg-desired-soft text-desired" : "bg-background text-muted border border-border"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <Link href={s.href} className="font-medium underline">
                    {s.title}
                  </Link>
                  <span className="text-xs text-muted">{s.screen}</span>
                  <span className={`text-xs ${s.done ? "text-desired" : "text-muted"}`}>
                    {s.done ? "in place" : s.tracked ? "not yet" : "open when ready"}
                  </span>
                </div>
                <p className="text-xs text-muted">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
