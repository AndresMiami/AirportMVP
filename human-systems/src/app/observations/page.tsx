"use client";
import Link from "next/link";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { ObservationForm, isWholeSystem, subjectLabelOf, type ObservationFormValues } from "@/components/observation-form";
import {
  InterpretationTag,
  LINK_KINDS,
  LINK_KIND_META,
  ObservationLinkPicker,
  describeLinkTarget,
  hypothesisKindLabel,
  linksOf,
  truncate,
  type LinkableEntities,
} from "@/components/observation-link-picker";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import * as mutations from "@/services/mutations";
import type { Hypothesis, Member, Observation } from "@/types";

type Mode = { kind: "idle" } | { kind: "create" } | { kind: "edit"; id: string };

/** Subject filter values: everything, the whole system, or one member. */
type SubjectFilter = "all" | "system" | `member:${string}`;

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SMALL = "rounded border border-border px-2 py-1 text-xs hover:bg-background disabled:opacity-50";

/** Marks the observation itself: neutral, deliberately unlike the interpretation tag. */
function ObservationTag() {
  return (
    <span
      className="inline-block rounded border border-border bg-background px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted"
      title="Something noticed or reported, kept as stated. Never a value, never a judgment."
    >
      observation
    </span>
  );
}

/** Where a hypothesis has recorded this observation as supporting or contradicting (set on the Hypotheses screen). */
interface HypothesisRoles {
  supporting: Hypothesis[];
  contradicting: Hypothesis[];
}

function linkCount(o: Observation): number {
  return o.links.variableIds.length + o.links.relationshipIds.length + o.links.constraintIds.length + o.links.hypothesisIds.length;
}

function ObservationView({
  o,
  members,
  systemId,
  entities,
  roles,
  linking,
  onEdit,
  onToggleLinks,
  removing,
  onRequestRemove,
  onCancelRemove,
  onRemove,
  removeError,
}: {
  o: Observation;
  members: readonly Member[];
  systemId: string;
  entities: LinkableEntities;
  roles: HypothesisRoles | undefined;
  linking: boolean;
  onEdit: () => void;
  onToggleLinks: () => void;
  removing: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  removeError: ReactNode;
}) {
  const links = linksOf(o);
  const total = linkCount(o);
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <ObservationTag />
          <span className="font-mono">{o.id}</span>
          {o.dateOrPeriod ? <span>· {o.dateOrPeriod}</span> : <span>· no date or period</span>}
          <span>· about {subjectLabelOf(o.subjectId, members, systemId)}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" className={SMALL} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={SMALL} aria-pressed={linking} onClick={onToggleLinks}>
            {linking ? "Close links" : "Links"}
          </button>
          <button type="button" className={SMALL} onClick={onRequestRemove} disabled={removing}>
            Delete
          </button>
        </div>
      </div>

      {removing ? (
        <div className="mt-2 rounded-md bg-warn-soft text-warn text-xs px-3 py-2 flex flex-wrap items-center gap-2">
          <span>Delete this observation? Any hypothesis that cites it drops the reference; nothing else changes.</span>
          <button type="button" className="rounded bg-neg text-white px-2 py-1" onClick={onRemove}>
            Delete
          </button>
          <button type="button" className="rounded border border-border bg-surface px-2 py-1 text-foreground" onClick={onCancelRemove}>
            Keep
          </button>
        </div>
      ) : null}
      {removeError}

      <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm">&ldquo;{o.statement}&rdquo;</blockquote>

      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Provenance</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <SourceBadge sourceType={o.sourceType} />
          <ConfidenceBadge confidence={o.confidence} />
          <span className="text-xs text-muted">confidence that it was noticed or reported as written</span>
        </dd>
        <dt className="text-muted">Evidence source</dt>
        <dd className="text-xs">{o.evidenceSource ? o.evidenceSource : <span className="text-muted">not recorded</span>}</dd>
        {o.notes ? (
          <>
            <dt className="text-muted">Notes</dt>
            <dd className="text-xs">{o.notes}</dd>
          </>
        ) : null}
        <dt className="text-muted">Bears on</dt>
        <dd>
          {total === 0 ? (
            <span className="text-xs text-muted">No links yet. Use Links to say which interpretations this observation bears on.</span>
          ) : (
            <div className="space-y-1.5">
              {LINK_KINDS.filter((kind) => links[kind].length > 0).map((kind) => (
                <div key={kind} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted">{LINK_KIND_META[kind].plural}</span>
                  <InterpretationTag />
                  {links[kind].map((target) => {
                    const d = describeLinkTarget(target, entities);
                    return (
                      <span
                        key={target.id}
                        className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${
                          d.missing ? "border-neg bg-neg-soft text-neg" : "border-border bg-background"
                        }`}
                      >
                        {d.text}
                        {d.tag ? <span className="text-muted">· {d.tag}</span> : null}
                        {d.missing ? <span className="text-muted">· not found</span> : null}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </dd>
        {roles && (roles.supporting.length > 0 || roles.contradicting.length > 0) ? (
          <>
            <dt className="text-muted">Cited by</dt>
            <dd className="space-y-1 text-xs">
              {roles.supporting.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">supports</span>
                  <InterpretationTag />
                  {roles.supporting.map((h) => (
                    <span key={h.id} className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5">
                      {truncate(h.statement)} <span className="text-muted">· {hypothesisKindLabel(h)}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {roles.contradicting.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">contradicts</span>
                  <InterpretationTag />
                  {roles.contradicting.map((h) => (
                    <span key={h.id} className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5">
                      {truncate(h.statement)} <span className="text-muted">· {hypothesisKindLabel(h)}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="text-muted">
                Roles are set on the{" "}
                <Link href="/hypotheses" className="underline">
                  Hypotheses
                </Link>{" "}
                screen.
              </div>
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export default function ObservationsPage() {
  const { model, evaluated, apply, lastError, clearError } = useModel();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [linking, setLinking] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<SubjectFilter>("all");
  /** Which control caused the last refusal, so lastError renders next to it. */
  const [errorAt, setErrorAt] = useState<string | null>(null);

  const entities = useMemo<LinkableEntities | null>(() => {
    if (!model || !evaluated) return null;
    return {
      variables: evaluated.variables,
      variableById: evaluated.variableById,
      relationships: model.relationships,
      constraints: model.constraints,
      hypotheses: model.hypotheses,
    };
  }, [model, evaluated]);

  /** obsId -> the hypotheses that record it as supporting / contradicting. */
  const rolesById = useMemo(() => {
    const map = new Map<string, HypothesisRoles>();
    if (!model) return map;
    const get = (id: string) => {
      const r = map.get(id) ?? { supporting: [], contradicting: [] };
      map.set(id, r);
      return r;
    };
    for (const h of model.hypotheses) {
      for (const id of h.supportingObservationIds) get(id).supporting.push(h);
      for (const id of h.contradictingObservationIds) get(id).contradicting.push(h);
    }
    return map;
  }, [model]);

  /** Run a mutation and remember which control asked for it. */
  const run = useCallback(
    (at: string, mutation: ModelMutation): boolean => {
      setErrorAt(at);
      const ok = apply(mutation);
      if (ok) setErrorAt(null);
      return ok;
    },
    [apply],
  );
  const errorTextFor = useCallback((at: string): string | null => (lastError && errorAt === at ? lastError : null), [lastError, errorAt]);
  const errorFor = (at: string): ReactNode => {
    const text = errorTextFor(at);
    return text ? (
      <p className="text-xs text-neg mt-1" role="alert">
        {text}
      </p>
    ) : null;
  };
  const resetError = () => {
    clearError();
    setErrorAt(null);
  };
  const settle = () => {
    resetError();
    setMode({ kind: "idle" });
  };

  if (!model || !evaluated || !entities) return <Loading />;
  const members = model.profile.members;
  const observations = model.observations;
  const systemId = model.id;

  const q = query.trim().toLowerCase();
  const visible = observations.filter((o) => {
    if (q && !o.statement.toLowerCase().includes(q)) return false;
    if (subjectFilter === "all") return true;
    if (subjectFilter === "system") return isWholeSystem(o.subjectId, systemId);
    return o.subjectId === subjectFilter.slice("member:".length);
  });
  const filtered = q !== "" || subjectFilter !== "all";

  const counts = {
    total: observations.length,
    unlinked: observations.filter((o) => linkCount(o) === 0).length,
    cited: observations.filter((o) => rolesById.has(o.id)).length,
  };

  return (
    <div>
      <PageHeader
        title="Observations"
        lede="Things noticed or reported, kept as stated. An observation is evidence the model can point at; it is never a value and never a judgment. Linking says which interpretations it bears on, nothing more."
      />

      <div className="grid gap-3 md:grid-cols-2">
        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              <ObservationTag />
              <span>Observation</span>
            </span>
          }
        >
          <p className="text-sm">Something noticed or reported, kept as stated. Never a value, never a judgment.</p>
          <p className="text-xs text-muted mt-2">
            Example: &ldquo;Mother&apos;s HHA income depends primarily on one client.&rdquo; The sentence is recorded verbatim; what it
            means for the model is decided elsewhere.
          </p>
        </Card>
        <Card
          tone="current"
          title={
            <span className="flex flex-wrap items-center gap-2">
              <InterpretationTag />
              <span>Interpretation</span>
            </span>
          }
        >
          <p className="text-sm">A variable value, a relationship, a hypothesis. Always carries confidence and can be wrong.</p>
          <p className="text-xs text-muted mt-2">
            On this page, every linked entity is an interpretation and is labelled as one. Nothing here turns an observation into a
            value: a value is entered on the{" "}
            <Link href="/variables" className="underline">
              Variables
            </Link>{" "}
            screen with its own provenance, and the observation is linked to it so the two stay distinct.
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
        <Stat label="Observations" value={counts.total} sub="kept verbatim" />
        <Stat label="Not linked yet" value={counts.unlinked} sub="bear on nothing recorded" />
        <Stat label="Cited by a hypothesis" value={counts.cited} sub="as supporting or contradicting" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          disabled={mode.kind === "create"}
          onClick={() => {
            resetError();
            setConfirmRemove(null);
            setMode({ kind: "create" });
          }}
        >
          Add observation
        </button>
        <input
          type="text"
          className="min-w-0 flex-1 sm:max-w-xs"
          placeholder="Filter statements…"
          aria-label="Filter observations by statement text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter observations by subject"
          className="text-xs"
          value={subjectFilter}
          onChange={(e) => setSubjectFilter(e.target.value as SubjectFilter)}
        >
          <option value="all">All subjects</option>
          <option value="system">whole system</option>
          {members.map((m) => (
            <option key={m.id} value={`member:${m.id}`}>
              {m.label}
            </option>
          ))}
        </select>
        {filtered ? (
          <button
            type="button"
            className={SMALL}
            onClick={() => {
              setQuery("");
              setSubjectFilter("all");
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {mode.kind === "create" ? (
        <Card title="New observation" className="mt-4">
          <ObservationForm
            key="create"
            members={members}
            systemId={systemId}
            onSubmit={(values: ObservationFormValues) => {
              if (run("form:create", (m) => mutations.addObservation(m, values))) setMode({ kind: "idle" });
            }}
            onCancel={settle}
            error={errorTextFor("form:create")}
            onEdit={clearError}
          />
        </Card>
      ) : null}

      <div className="mt-4 space-y-4">
        {observations.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No observations recorded yet. Add what was noticed or reported, as stated; link it to the interpretations it bears on afterwards.</p>
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">
              No observation matches the current filters ({observations.length} recorded).
            </p>
          </Card>
        ) : null}
        {filtered && visible.length > 0 ? (
          <p className="text-xs text-muted">
            Showing {visible.length} of {observations.length}, in the order they were recorded.
          </p>
        ) : null}
        {visible.map((o) => {
          const editing = mode.kind === "edit" && mode.id === o.id;
          const isLinking = linking === o.id;
          return (
            <Card key={o.id} tone={editing ? "current" : "neutral"} title={editing ? `Editing ${o.id}` : undefined}>
              {editing ? (
                <ObservationForm
                  key={o.id}
                  initial={o}
                  members={members}
                  systemId={systemId}
                  onSubmit={(values: ObservationFormValues) => {
                    if (run(`form:${o.id}`, (m) => mutations.updateObservation(m, o.id, values))) setMode({ kind: "idle" });
                  }}
                  onCancel={settle}
                  error={errorTextFor(`form:${o.id}`)}
                  onEdit={clearError}
                />
              ) : (
                <ObservationView
                  o={o}
                  members={members}
                  systemId={systemId}
                  entities={entities}
                  roles={rolesById.get(o.id)}
                  linking={isLinking}
                  onEdit={() => {
                    resetError();
                    setConfirmRemove(null);
                    setMode({ kind: "edit", id: o.id });
                  }}
                  onToggleLinks={() => {
                    resetError();
                    setConfirmRemove(null);
                    setLinking(isLinking ? null : o.id);
                  }}
                  removing={confirmRemove === o.id}
                  onRequestRemove={() => {
                    resetError();
                    setConfirmRemove(o.id);
                  }}
                  onCancelRemove={() => {
                    resetError();
                    setConfirmRemove(null);
                  }}
                  onRemove={() => {
                    if (run(`remove:${o.id}`, (m) => mutations.removeObservation(m, o.id))) {
                      setConfirmRemove(null);
                      if (linking === o.id) setLinking(null);
                    }
                  }}
                  removeError={errorFor(`remove:${o.id}`)}
                />
              )}
              {isLinking ? (
                <div className="mt-4 border-t border-border pt-3">
                  <ObservationLinkPicker observation={o} entities={entities} commit={run} errorFor={errorTextFor} clearError={clearError} />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <div className="mt-4">
        <Note>
          Observations are listed in the order they were recorded; the date or period is shown exactly as entered and is never parsed.
          Confidence on an observation describes how sure the record is that it was noticed or reported as written, not whether any
          interpretation of it is right.
        </Note>
      </div>
    </div>
  );
}
