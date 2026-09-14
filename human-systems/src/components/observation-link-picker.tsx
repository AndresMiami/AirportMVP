"use client";
/**
 * Link picker for ONE observation: four selects (variables, relationships,
 * constraints, hypotheses), each with a "Link" button, plus the current
 * links as removable chips. Display-only: every change goes through the
 * page's `commit(owner, mutation)` (useModel().apply + services/mutations
 * linkObservation / unlinkObservation). A link records "this observation
 * bears on"; it never turns the observation into a value and never sets a
 * hypothesis role (supporting / contradicting lives on the Hypotheses
 * screen).
 *
 * The name-resolution helpers are exported so the Observations list can
 * describe stored links with the same wording.
 */
import Link from "next/link";
import { useId, useState } from "react";
import type { ModelMutation } from "@/components/model-provider";
import * as mutations from "@/services/mutations";
import type { LinkTarget } from "@/services/mutations";
import type { Constraint, Hypothesis, Observation, Relationship, Variable } from "@/types";

export type LinkKind = LinkTarget["kind"];

export const LINK_KINDS: readonly LinkKind[] = ["variable", "relationship", "constraint", "hypothesis"];

export const LINK_KIND_META: Record<LinkKind, { label: string; plural: string; linksKey: keyof Observation["links"] }> = {
  variable: { label: "Variable", plural: "Variables", linksKey: "variableIds" },
  relationship: { label: "Relationship", plural: "Relationships", linksKey: "relationshipIds" },
  constraint: { label: "Constraint", plural: "Constraints", linksKey: "constraintIds" },
  hypothesis: { label: "Hypothesis", plural: "Hypotheses", linksKey: "hypothesisIds" },
};

/** The entity lists that links are resolved against. */
export interface LinkableEntities {
  variables: readonly Variable[];
  variableById: ReadonlyMap<string, Variable>;
  relationships: readonly Relationship[];
  constraints: readonly Constraint[];
  hypotheses: readonly Hypothesis[];
}

/* ------------------------------------------------------------------ */
/* Pure display helpers                                                */
/* ------------------------------------------------------------------ */

export function truncate(text: string, max = 80): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "loop hypothesis" for kind "loop", otherwise plain "hypothesis". */
export function hypothesisKindLabel(h: Hypothesis): string {
  return h.kind === "loop" ? "loop hypothesis" : "hypothesis";
}

export function relationshipLabel(r: Relationship, variableById: ReadonlyMap<string, Variable>): string {
  const nameOf = (id: string) => variableById.get(id)?.name ?? id;
  return `${nameOf(r.sourceVariableId)} → ${nameOf(r.targetVariableId)}`;
}

export interface LinkDescription {
  /** The entity's display name (variable name, "source → target", …). */
  text: string;
  /** A small qualifier shown next to the name, e.g. "calculated", "loop hypothesis". */
  tag?: string;
  /** True when the id no longer resolves (should not happen; mutations validate links). */
  missing: boolean;
}

/** Display description of a link target, or a fallback that names the id. */
export function describeLinkTarget(target: LinkTarget, e: LinkableEntities): LinkDescription {
  switch (target.kind) {
    case "variable": {
      const v = e.variableById.get(target.id);
      if (!v) return { text: target.id, missing: true };
      return { text: v.name, tag: v.kind === "derived" ? "calculated" : undefined, missing: false };
    }
    case "relationship": {
      const r = e.relationships.find((x) => x.id === target.id);
      if (!r) return { text: target.id, missing: true };
      return { text: relationshipLabel(r, e.variableById), tag: r.enabled ? undefined : "disabled", missing: false };
    }
    case "constraint": {
      const c = e.constraints.find((x) => x.id === target.id);
      if (!c) return { text: target.id, missing: true };
      return { text: c.name, tag: c.type, missing: false };
    }
    case "hypothesis": {
      const h = e.hypotheses.find((x) => x.id === target.id);
      if (!h) return { text: target.id, missing: true };
      return { text: truncate(h.statement), tag: hypothesisKindLabel(h), missing: false };
    }
  }
}

/** Every stored link of an observation as LinkTarget values, kind by kind. */
export function linksOf(o: Observation): Record<LinkKind, LinkTarget[]> {
  return {
    variable: o.links.variableIds.map((id) => ({ kind: "variable", id })),
    relationship: o.links.relationshipIds.map((id) => ({ kind: "relationship", id })),
    constraint: o.links.constraintIds.map((id) => ({ kind: "constraint", id })),
    hypothesis: o.links.hypothesisIds.map((id) => ({ kind: "hypothesis", id })),
  };
}

/** Marks anything interpretive (a variable, a relationship, a hypothesis). */
export function InterpretationTag() {
  return (
    <span
      className="inline-block rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent"
      title="A variable value, a relationship, a constraint or a hypothesis: always carries confidence and can be wrong."
    >
      interpretation
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Picker                                                              */
/* ------------------------------------------------------------------ */

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50";

interface Option {
  id: string;
  label: string;
}

function optionsFor(kind: LinkKind, e: LinkableEntities): Option[] {
  switch (kind) {
    case "variable":
      return [...e.variables]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => ({ id: v.id, label: v.kind === "derived" ? `${v.name} (calculated)` : v.name }));
    case "relationship":
      return e.relationships.map((r) => ({
        id: r.id,
        label: `${relationshipLabel(r, e.variableById)}${r.enabled ? "" : " (disabled)"}`,
      }));
    case "constraint":
      return [...e.constraints]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ id: c.id, label: `${c.name} (${c.type})` }));
    case "hypothesis":
      return e.hypotheses.map((h) => ({ id: h.id, label: `[${hypothesisKindLabel(h)}] ${truncate(h.statement, 90)}` }));
  }
}

export function ObservationLinkPicker({
  observation,
  entities,
  commit,
  errorFor,
  clearError,
}: {
  observation: Observation;
  entities: LinkableEntities;
  /** Runs a mutation through useModel().apply; `owner` tags where a refusal is shown. */
  commit: (owner: string, mutation: ModelMutation) => boolean;
  /** lastError when the last refused commit belonged to `owner`, else null. */
  errorFor: (owner: string) => string | null;
  clearError: () => void;
}) {
  const uid = useId();
  const [choice, setChoice] = useState<Record<LinkKind, string>>({
    variable: "",
    relationship: "",
    constraint: "",
    hypothesis: "",
  });
  const current = linksOf(observation);

  const link = (kind: LinkKind) => {
    const id = choice[kind];
    if (!id) return;
    const ok = commit(`link:${observation.id}:${kind}`, (m) => mutations.linkObservation(m, observation.id, { kind, id }));
    if (ok) setChoice((c) => ({ ...c, [kind]: "" }));
  };

  const unlink = (target: LinkTarget) => {
    commit(`unlink:${observation.id}:${target.kind}`, (m) => mutations.unlinkObservation(m, observation.id, target));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">Links: what this observation bears on</h4>
        <InterpretationTag />
      </div>
      <p className="text-xs text-muted">
        A link says the observation is relevant to an interpretation. It does not give the observation a value, and it does not
        change the interpretation&apos;s confidence.
      </p>

      {LINK_KINDS.map((kind) => {
        const meta = LINK_KIND_META[kind];
        const linked = new Set(current[kind].map((t) => t.id));
        const remaining = optionsFor(kind, entities).filter((opt) => !linked.has(opt.id));
        const selectId = `${uid}-${kind}`;
        const linkError = errorFor(`link:${observation.id}:${kind}`);
        const unlinkError = errorFor(`unlink:${observation.id}:${kind}`);
        return (
          <div key={kind} className="rounded-md border border-border bg-background/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <label htmlFor={selectId} className="text-xs font-medium text-muted">
                {meta.plural}
              </label>
              <InterpretationTag />
            </div>

            {current[kind].length === 0 ? (
              <p className="text-xs text-muted mb-1.5">No {meta.plural.toLowerCase()} linked.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5 mb-1.5">
                {current[kind].map((target) => {
                  const d = describeLinkTarget(target, entities);
                  return (
                    <li
                      key={target.id}
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${
                        d.missing ? "border-neg bg-neg-soft text-neg" : "border-border bg-surface"
                      }`}
                    >
                      <span>{d.text}</span>
                      {d.tag ? <span className="text-muted">· {d.tag}</span> : null}
                      {d.missing ? <span className="text-muted">· not found</span> : null}
                      <button
                        type="button"
                        className="text-muted hover:text-neg"
                        aria-label={`Unlink ${meta.label.toLowerCase()} ${d.text}`}
                        title="Remove this link"
                        onClick={() => unlink(target)}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {unlinkError ? (
              <p className="text-xs text-neg mb-1.5" role="alert">
                {unlinkError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <select
                id={selectId}
                className="min-w-0 flex-1 text-xs"
                value={choice[kind]}
                disabled={remaining.length === 0}
                onChange={(e) => {
                  clearError();
                  setChoice((c) => ({ ...c, [kind]: e.target.value }));
                }}
              >
                <option value="">
                  {remaining.length === 0 ? `— no ${meta.plural.toLowerCase()} left to link —` : `— choose a ${meta.label.toLowerCase()} —`}
                </option>
                {remaining.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button type="button" className={BTN} disabled={!choice[kind]} onClick={() => link(kind)}>
                Link
              </button>
            </div>
            {linkError ? (
              <p className="text-xs text-neg mt-1" role="alert">
                {linkError}
              </p>
            ) : null}
            {kind === "hypothesis" ? (
              <p className="text-xs text-muted mt-1.5">
                This is the generic link. Marking an observation as supporting or contradicting a hypothesis is done on the{" "}
                <Link href="/hypotheses" className="underline">
                  Hypotheses
                </Link>{" "}
                screen.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
