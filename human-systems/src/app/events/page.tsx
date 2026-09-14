"use client";
/**
 * Events: the dated history of the system — shocks, changes, interventions,
 * outcomes and decisions. An event is a fact with a time reference, never a
 * numeric variable; interventions record what the person EXPECTED to move so
 * a later outcome can be compared with the expectation. The timeline orders
 * by the structured time reference; entries with no usable date come last.
 * Every change goes through useModel().apply with a pure mutation.
 */
import { useMemo, useState, type ReactNode } from "react";
import { formatTemporal, temporalSortKey } from "@/calculations/time";
import { EVENT_KIND_META, EventForm, INTERVENTION_STATUS_META, eventSubjectLabel, type EventFormValues } from "@/components/event-form";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import * as mutations from "@/services/mutations";
import { EventKindSchema, type Event, type EventKind, type Member, type Variable } from "@/types";

type Mode = { kind: "idle" } | { kind: "create" } | { kind: "edit"; id: string };

const PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";
const SMALL = "rounded border border-border bg-background px-2 py-1 text-xs hover:border-accent disabled:opacity-50";

const KIND_TONE: Record<EventKind, string> = {
  shock: "bg-neg-soft text-neg",
  change: "bg-background border border-border",
  intervention: "bg-accent-soft text-accent",
  outcome: "bg-desired-soft text-desired",
  decision: "bg-warn-soft text-warn",
};

function EventKindBadge({ kind }: { kind: EventKind }) {
  const meta = EVENT_KIND_META[kind];
  return (
    <span title={meta.description} className={`inline-block rounded px-1.5 py-0.5 text-xs ${KIND_TONE[kind]}`}>
      {meta.label}
    </span>
  );
}

/** Timeline order: dated entries by their start, then entries with no usable date, each group by recordedAt. */
function timelineOrder(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => {
    const ka = temporalSortKey(a.occurred);
    const kb = temporalSortKey(b.occurred);
    if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -1 : 1;
    if (ka === null && kb !== null) return 1;
    if (ka !== null && kb === null) return -1;
    return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0;
  });
}

function EventView({
  e,
  members,
  systemId,
  variableById,
  onEdit,
  removing,
  onRequestRemove,
  onCancelRemove,
  onRemove,
  removeError,
  busy,
}: {
  e: Event;
  members: readonly Member[];
  systemId: string;
  variableById: ReadonlyMap<string, Variable>;
  onEdit: () => void;
  removing: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  removeError: ReactNode;
  /** Another form is open: the controls stay visible but inert. */
  busy: boolean;
}) {
  const dated = temporalSortKey(e.occurred) !== null;
  const linked = e.observationIds.length;
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-[16rem]">
          <div className="flex flex-wrap items-center gap-1.5">
            <EventKindBadge kind={e.kind} />
            <span className="text-xs text-muted font-mono">{e.type}</span>
            <span className={`text-xs ${dated ? "text-muted" : "text-warn"}`} title={dated ? "ordered by this time" : "no usable date; listed after dated entries"}>
              {formatTemporal(e.occurred)}
              {!dated ? " (undated)" : ""}
            </span>
          </div>
          <p className="text-sm font-medium mt-1">{e.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{eventSubjectLabel(e.subjectId, members, systemId)}</span>
            <SourceBadge sourceType={e.sourceType} />
            <ConfidenceBadge confidence={e.confidence} />
            <span>
              {linked} linked observation{linked === 1 ? "" : "s"}
            </span>
            <span className="font-mono">{e.id}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={SMALL} onClick={onEdit} disabled={busy || removing}>
            Edit
          </button>
          <button type="button" className={SMALL} onClick={onRequestRemove} disabled={busy || removing}>
            Remove
          </button>
        </div>
      </div>

      {e.description ? <p className="text-sm mt-2">{e.description}</p> : null}

      {e.kind === "intervention" ? (
        <div className="mt-2 text-sm">
          <div className="text-xs text-muted">
            Intervention status: <span className="text-foreground">{e.status ? INTERVENTION_STATUS_META[e.status] : "not recorded"}</span>
          </div>
          {e.expected.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {e.expected.map((x) => (
                <li key={x.variableId} className="rounded border border-border bg-background px-1.5 py-0.5 text-xs">
                  {variableById.get(x.variableId)?.name ?? `${x.variableId} (no longer stored)`} <span className="text-muted">expected {x.direction}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted mt-1">No expected effect recorded.</p>
          )}
        </div>
      ) : null}

      {e.notes ? (
        <div className="mt-2 text-sm">
          <div className="text-xs text-muted">Notes</div>
          <p>{e.notes}</p>
        </div>
      ) : null}

      {removing ? (
        <div className="mt-3 rounded-md bg-neg-soft px-3 py-2 text-sm">
          <p className="mb-2">Remove this event? Other events that referred to it keep their record; only the reference is dropped.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded bg-neg text-white px-2 py-1 text-xs" onClick={onRemove}>
              Remove
            </button>
            <button type="button" className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground" onClick={onCancelRemove}>
              Cancel
            </button>
          </div>
          {removeError}
        </div>
      ) : null}
    </li>
  );
}

export default function EventsPage() {
  const { model, evaluated, apply, lastError, clearError } = useModel();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** Which control caused the last refusal, so lastError renders next to it. */
  const [errorAt, setErrorAt] = useState<string | null>(null);

  const ordered = useMemo(() => timelineOrder(model?.events ?? []), [model]);

  if (!model || !evaluated) return <Loading />;
  const members = model.profile.members;
  const { variables, variableById, domain } = evaluated;
  const counts = Object.fromEntries(EventKindSchema.options.map((k) => [k, ordered.filter((e) => e.kind === k).length])) as Record<EventKind, number>;
  const undated = ordered.filter((e) => temporalSortKey(e.occurred) === null).length;

  const run = (at: string, mutation: ModelMutation): boolean => {
    setErrorAt(at);
    const ok = apply(mutation);
    if (ok) setErrorAt(null);
    return ok;
  };
  const errorText = (at: string): string | null => (lastError && errorAt === at ? lastError : null);
  const errorFor = (at: string): ReactNode => {
    const text = errorText(at);
    return text ? (
      <p className="text-xs text-neg mt-1" role="alert">
        {text}
      </p>
    ) : null;
  };
  const settle = () => {
    clearError();
    setErrorAt(null);
    setMode({ kind: "idle" });
  };
  const editingId = mode.kind === "edit" ? mode.id : null;

  const submitForm = (values: EventFormValues) => {
    const ok =
      mode.kind === "edit"
        ? run(`form:${mode.id}`, (m) => mutations.updateEvent(m, mode.id, values))
        : run("form:create", (m) => mutations.addEvent(m, { ...values, recordedAt: new Date().toISOString() }));
    if (ok) setMode({ kind: "idle" });
  };

  const formFor = (initial?: Event) => (
    <EventForm
      key={initial?.id ?? "create"}
      initial={initial}
      eventTypes={domain.eventTypes}
      members={members}
      systemId={model.id}
      variables={variables}
      onSubmit={submitForm}
      onCancel={settle}
      error={errorText(initial ? `form:${initial.id}` : "form:create")}
      onEdit={clearError}
    />
  );

  return (
    <div>
      <PageHeader
        title="Events"
        lede="The dated history of the system: shocks, changes, interventions, outcomes and decisions. An event is a fact with a time reference, never a numeric variable. Interventions carry the person's expected effects so a later outcome can be compared with what was expected."
      />
      <Note>
        Time is kept as written and, when the person sets one, as a structured reference used only for ordering. Unknown is unknown: an undated event is listed last, never given a date.
      </Note>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-4">
        {EventKindSchema.options.map((k) => (
          <Stat key={k} label={EVENT_KIND_META[k].label} value={counts[k]} sub={EVENT_KIND_META[k].description} />
        ))}
      </div>

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
          New event
        </button>
        <span className="text-xs text-muted">
          {ordered.length} recorded · {undated} undated
        </span>
      </div>

      {mode.kind === "create" ? (
        <div className="mt-4">
          <Card title="New event" className="border-accent">
            {formFor()}
          </Card>
        </div>
      ) : null}

      <div className="mt-4">
        <h2 className="text-sm font-semibold mb-2">Timeline ({ordered.length})</h2>
        {ordered.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No events recorded yet. Add the first one above.</p>
          </Card>
        ) : (
          <ol className="space-y-3">
            {ordered.map((e) =>
              editingId === e.id ? (
                <li key={e.id}>
                  <Card title={`Edit event ${e.id}`} className="border-accent">
                    {formFor(e)}
                  </Card>
                </li>
              ) : (
                <EventView
                  key={e.id}
                  e={e}
                  members={members}
                  systemId={model.id}
                  variableById={variableById}
                  busy={mode.kind !== "idle"}
                  onEdit={() => {
                    clearError();
                    setErrorAt(null);
                    setConfirmRemove(null);
                    setMode({ kind: "edit", id: e.id });
                  }}
                  removing={confirmRemove === e.id}
                  onRequestRemove={() => {
                    clearError();
                    setErrorAt(null);
                    setConfirmRemove(e.id);
                  }}
                  onCancelRemove={() => {
                    clearError();
                    setErrorAt(null);
                    setConfirmRemove(null);
                  }}
                  onRemove={() => {
                    const ok = run(`remove:${e.id}`, (m) => mutations.removeEvent(m, e.id));
                    if (ok) setConfirmRemove(null);
                  }}
                  removeError={errorFor(`remove:${e.id}`)}
                />
              ),
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
