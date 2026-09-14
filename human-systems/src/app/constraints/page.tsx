"use client";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ConstraintForm, TYPE_MEANING, describeCheck, subjectLabelOf, type ConstraintFormValues } from "@/components/constraint-form";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { fmtPct } from "@/components/format";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import * as mutations from "@/services/mutations";
import type { Constraint, ConstraintType, Observation } from "@/types";

type Mode = { kind: "idle" } | { kind: "create" } | { kind: "edit"; id: string };

/** How one constraint fell out of the feasibility check across the actions. */
interface Usage {
  excludes: number;
  lowers: number;
  unverified: number;
  unchecked: number;
}

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SMALL = "rounded border border-border px-2 py-1 text-xs hover:bg-background";

function TypeBadge({ type }: { type: ConstraintType }) {
  const tone = type === "hard" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${tone}`}>{type}</span>
      <span className="text-muted">{TYPE_MEANING[type]}</span>
    </span>
  );
}

function usageText(c: Constraint, u: Usage | undefined, actionCount: number): string {
  const plural = actionCount === 1 ? "" : "s";
  if (actionCount === 0) return "No candidate actions recorded yet.";
  if (!c.check) return `Unchecked for all ${actionCount} candidate action${plural} (no machine check).`;
  const parts: string[] = [];
  if (c.type === "hard") parts.push(`conflicts with ${u?.excludes ?? 0} (excluded)`);
  else parts.push(`lowers suitability for ${u?.lowers ?? 0}`);
  if ((u?.unverified ?? 0) > 0) parts.push(`unverified for ${u?.unverified} (dimension not declared by the action)`);
  return `Of ${actionCount} candidate action${plural}: ${parts.join(" · ")}.`;
}

function ConstraintView({
  c,
  subject,
  usage,
  actionCount,
  linked,
  onEdit,
  onToggleConfirmed,
  confirmError,
  removing,
  onRequestRemove,
  onCancelRemove,
  onRemove,
  removeError,
}: {
  c: Constraint;
  /** Display label of the constraint's subject. */
  subject: string;
  usage: Usage | undefined;
  actionCount: number;
  linked: Observation[];
  onEdit: () => void;
  onToggleConfirmed: (confirmed: boolean) => void;
  confirmError: ReactNode;
  removing: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  removeError: ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{c.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <TypeBadge type={c.type} />
            <span className={`text-xs ${c.subjectId === null ? "rounded px-1.5 py-0.5 bg-warn-soft text-warn" : "text-muted"}`}>
              {c.subjectId === null ? "subject unassigned" : `subject: ${subject}`}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" className={SMALL} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={SMALL} onClick={onRequestRemove} disabled={removing}>
            Remove
          </button>
        </div>
      </div>
      {removing ? (
        <div className="mt-2 rounded-md bg-warn-soft text-warn text-xs px-3 py-2 flex flex-wrap items-center gap-2">
          <span>
            Remove &ldquo;{c.name}&rdquo;? Observations linked to it are kept; only the link is dropped.
          </span>
          <button type="button" className="rounded bg-neg text-white px-2 py-1" onClick={onRemove}>
            Remove
          </button>
          <button type="button" className="rounded border border-border bg-surface px-2 py-1 text-foreground" onClick={onCancelRemove}>
            Keep
          </button>
        </div>
      ) : null}
      {removeError}
      {c.description ? <p className="text-sm mt-2 max-w-2xl">{c.description}</p> : null}
      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Check</dt>
        <dd>
          {c.check ? (
            <span className="font-mono text-xs bg-background border border-border rounded px-1.5 py-0.5">{describeCheck(c.check)}</span>
          ) : (
            <span className="text-muted">none — descriptive; listed as unchecked for every action</span>
          )}
        </dd>
        {c.type === "soft" ? (
          <>
            <dt className="text-muted">Soft penalty</dt>
            <dd>
              <span className="tabular-nums">{fmtPct(c.softPenalty)}</span>
              <span className="text-xs text-muted"> — a violation multiplies suitability by {(1 - c.softPenalty).toFixed(2)}</span>
            </dd>
          </>
        ) : null}
        <dt className="text-muted">Provenance</dt>
        <dd className="flex flex-wrap gap-1">
          <SourceBadge sourceType={c.sourceType} />
          <ConfidenceBadge confidence={c.confidence} />
        </dd>
        <dt className="text-muted">Confirmed</dt>
        <dd>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={c.userConfirmed} onChange={(e) => onToggleConfirmed(e.target.checked)} />
              I confirm this applies
            </label>
            {!c.userConfirmed ? (
              <span className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-muted">not yet confirmed by the person</span>
            ) : null}
          </div>
          {confirmError}
        </dd>
        <dt className="text-muted">Evidence</dt>
        <dd>
          {c.evidence.length === 0 ? (
            <span className="text-xs text-muted">none recorded</span>
          ) : (
            <ul className="space-y-1">
              {c.evidence.map((e, i) => (
                <li key={i} className="text-xs">
                  <SourceBadge sourceType={e.sourceType} /> {e.text}
                  {e.recordedAt ? <span className="text-muted"> ({e.recordedAt})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </dd>
        {c.notes ? (
          <>
            <dt className="text-muted">Notes</dt>
            <dd className="text-xs">{c.notes}</dd>
          </>
        ) : null}
        <dt className="text-muted">Against actions</dt>
        <dd className="text-xs text-muted">{usageText(c, usage, actionCount)}</dd>
        <dt className="text-muted">Linked observations</dt>
        <dd>
          {linked.length > 0 ? (
            <ul className="space-y-1 mb-1">
              {linked.map((o) => (
                <li key={o.id} className="text-xs">
                  &ldquo;{o.statement}&rdquo;
                  {o.dateOrPeriod ? <span className="text-muted"> — {o.dateOrPeriod}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <span className="text-xs text-muted">
            {linked.length === 0 ? "None linked. " : ""}
            Linking happens on the{" "}
            <Link href="/observations" className="underline">
              Observations
            </Link>{" "}
            screen; observations stay verbatim and never become values.
          </span>
        </dd>
      </dl>
    </div>
  );
}

export default function ConstraintsPage() {
  const { evaluated, apply, lastError, clearError } = useModel();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** Which control caused the last refusal, so lastError renders next to it. */
  const [errorAt, setErrorAt] = useState<string | null>(null);

  const usage = useMemo(() => {
    const map = new Map<string, Usage>();
    if (!evaluated) return map;
    const bump = (id: string, key: keyof Usage) => {
      const u = map.get(id) ?? { excludes: 0, lowers: 0, unverified: 0, unchecked: 0 };
      u[key] += 1;
      map.set(id, u);
    };
    for (const a of evaluated.actions) {
      for (const v of a.feasibility.hardViolations) bump(v.constraint.id, "excludes");
      for (const v of a.feasibility.softViolations) bump(v.constraint.id, "lowers");
      for (const c of a.feasibility.unverified) bump(c.id, "unverified");
      for (const c of a.feasibility.unchecked) bump(c.id, "unchecked");
    }
    return map;
  }, [evaluated]);

  if (!evaluated) return <Loading />;
  const { model, observations, domain } = evaluated;
  const members = model.profile.members;
  const constraints = model.constraints;
  const actionCount = model.actions.length;
  const counts = {
    hard: constraints.filter((c) => c.type === "hard").length,
    soft: constraints.filter((c) => c.type === "soft").length,
    descriptive: constraints.filter((c) => !c.check).length,
    unconfirmed: constraints.filter((c) => !c.userConfirmed).length,
    unassigned: constraints.filter((c) => c.subjectId === null).length,
  };

  /** Run a mutation and remember which control asked for it. */
  const run = (at: string, mutation: ModelMutation): boolean => {
    setErrorAt(at);
    const ok = apply(mutation);
    if (ok) setErrorAt(null);
    return ok;
  };
  const errorFor = (at: string): ReactNode =>
    lastError && errorAt === at ? <p className="text-xs text-neg mt-1">{lastError}</p> : null;
  const settle = () => {
    clearError();
    setErrorAt(null);
    setMode({ kind: "idle" });
  };

  return (
    <div>
      <PageHeader
        title="Constraints"
        lede="What the person has said cannot happen, or would rather avoid. Each constraint is a statement with provenance; the model checks it against a candidate action only when it carries a machine-readable rule on a dimension the action declares."
      />
      <Note>
        Hard constraints make an action infeasible: a violated hard constraint excludes the action from the leverage ranking rather than down-weighting it (assumption A14). Soft constraints reduce suitability but never exclude: each violated soft constraint multiplies suitability by (1 − penalty), and suitability is shown next to the rank, never folded into it (A17). Constraints without a check are descriptive and are listed as unchecked for every action.
      </Note>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
        <Stat label="Hard" value={counts.hard} sub="exclude actions" />
        <Stat label="Soft" value={counts.soft} sub="lower suitability" />
        <Stat label="Descriptive (no check)" value={counts.descriptive} sub="unchecked for every action" />
        <Stat label="Not yet confirmed" value={counts.unconfirmed} sub="by the person" />
      </div>
      {counts.unassigned > 0 ? (
        <div className="mt-4">
          <Note>
            {counts.unassigned} constraint{counts.unassigned > 1 ? "s have" : " has"} no subject assigned; choose whose it is with Edit.
          </Note>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          disabled={mode.kind === "create"}
          onClick={() => {
            clearError();
            setErrorAt(null);
            setConfirmRemove(null);
            setMode({ kind: "create" });
          }}
        >
          Add constraint
        </button>
        <span className="text-xs text-muted">
          Actions declare their requirements on the same dimension keys (hoursPerWeek, capitalRequired, requiresRelocation, …). A check on a dimension an action does not declare is reported as unverified for that action.
        </span>
      </div>

      {mode.kind === "create" ? (
        <Card title="New constraint" tone="current" className="mt-4">
          <ConstraintForm
            key="create"
            templates={domain.constraintTemplates}
            members={members}
            systemId={model.id}
            onSubmit={(values: ConstraintFormValues) => {
              if (run("form:create", (m) => mutations.addConstraint(m, values))) setMode({ kind: "idle" });
            }}
            onCancel={settle}
            error={errorAt === "form:create" ? lastError : null}
            onEdit={clearError}
          />
        </Card>
      ) : null}

      <div className="mt-4 space-y-4">
        {constraints.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No constraints recorded yet. Every candidate action is treated as feasible until one is added.</p>
          </Card>
        ) : null}
        {constraints.map((c) => {
          const editing = mode.kind === "edit" && mode.id === c.id;
          return (
            <Card key={c.id} tone={editing ? "current" : "neutral"} title={editing ? `Editing “${c.name}”` : undefined}>
              {editing ? (
                <ConstraintForm
                  key={c.id}
                  initial={c}
                  templates={domain.constraintTemplates}
                  members={members}
                  systemId={model.id}
                  onSubmit={(values: ConstraintFormValues) => {
                    if (run(`form:${c.id}`, (m) => mutations.updateConstraint(m, c.id, values))) setMode({ kind: "idle" });
                  }}
                  onCancel={settle}
                  error={errorAt === `form:${c.id}` ? lastError : null}
                  onEdit={clearError}
                />
              ) : (
                <ConstraintView
                  c={c}
                  subject={subjectLabelOf(c.subjectId, members, model.id)}
                  usage={usage.get(c.id)}
                  actionCount={actionCount}
                  linked={observations.byConstraint.get(c.id) ?? []}
                  onEdit={() => {
                    clearError();
                    setErrorAt(null);
                    setConfirmRemove(null);
                    setMode({ kind: "edit", id: c.id });
                  }}
                  onToggleConfirmed={(userConfirmed) => {
                    run(`confirm:${c.id}`, (m) => mutations.updateConstraint(m, c.id, { userConfirmed }));
                  }}
                  confirmError={errorFor(`confirm:${c.id}`)}
                  removing={confirmRemove === c.id}
                  onRequestRemove={() => {
                    clearError();
                    setErrorAt(null);
                    setConfirmRemove(c.id);
                  }}
                  onCancelRemove={() => {
                    clearError();
                    setErrorAt(null);
                    setConfirmRemove(null);
                  }}
                  onRemove={() => {
                    if (run(`remove:${c.id}`, (m) => mutations.removeConstraint(m, c.id))) setConfirmRemove(null);
                  }}
                  removeError={errorFor(`remove:${c.id}`)}
                />
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-4">
        <Note>
          Whether a constraint applies is the person&apos;s statement, not a measurement: confidence and source describe how the statement was obtained. The Leverage screen shows which actions each constraint excludes or makes less suitable.
        </Note>
      </div>
    </div>
  );
}
