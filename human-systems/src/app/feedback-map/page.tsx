"use client";
/**
 * MAP (Step 6E: simplified presentation, same relationship and loop
 * semantics) — "What seems connected?" The visual network comes first;
 * the technical model is edited only when the person deliberately asks.
 *
 *   the map                 -> the SAME NetworkDiagram over the SAME
 *                              evaluated variables and allRelationships
 *   Connected with X        -> a selected variable's connections, in
 *                              ordinary language (same highlight rule)
 *   Connection              -> a selected connection, read-only first:
 *                              kind, direction sentence, explanation, lag;
 *                              strength / confidence / provenance /
 *                              dynamics / enabled / linked observations /
 *                              exact meaning under Details; "Edit
 *                              connection" opens the existing editor
 *   Feedback patterns       -> the engine's detected loops exactly
 *                              (chain + polarity); the full LoopList entry
 *                              under Details; selecting highlights the
 *                              same loop nodes and edges
 *   Edit map (collapsed)    -> New relationship, Connect on diagram, the
 *                              unclassified filter, the editor, the full
 *                              relationships table, enable/disable
 *   About this map          -> the five counts and the full legend
 *
 * Nothing about relationships, loop detection, dynamics eligibility,
 * direction, strength, lag, confidence or enabled state changes here.
 * Every write still goes through useModel().apply and the canonical
 * mutation functions, from the existing RelationshipEditor and table.
 * BACKLOG (recorded, not this step): defaultRelationshipDraft() still
 * initialises a new relationship with strength 0.5 and confidence 0.5;
 * AI must not rely on those defaults, and a later epistemic cleanup
 * decides whether "not assessed" belongs in these canonical fields.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatLag, horizonOfLag } from "@/calculations/lag";
import { LoopList } from "@/components/loop-list";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { NetworkDiagram } from "@/components/network-diagram";
import { JudgmentBanner, RELATIONSHIP_KIND_META, RelationshipEditor } from "@/components/relationship-editor";
import { ConfidenceBadge, Loading, SourceBadge } from "@/components/ui";
import { connectionsOf, highlightFor } from "@/features/map/selection";
import { KIND_LABELS, KIND_MEANINGS, MAP_EPISTEMIC, MAP_READING_HINT, STRENGTH_NOTE, connectionSentence, connectionTitle, connectionUseNote, loopChainSentence, mapCounts, orphanNotice, patternLabel, unclassifiedNotice } from "@/features/map/wording";
import * as mutations from "@/services/mutations";

type EditorState = { kind: "closed" } | { kind: "create"; sourceId?: string; targetId?: string } | { kind: "edit"; id: string };

const TOGGLE = "text-sm text-muted hover:text-foreground hover:underline disabled:opacity-50 disabled:cursor-not-allowed";
const ACTION = "text-[15px] font-medium text-accent hover:underline";
const PRIMARY = "rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-50";
const QUIET = "rounded-full border border-border bg-surface px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50";

/** Lag labels are hidden on very narrow viewports for readability only; stored lags and calculations are untouched. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 480px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

export default function FeedbackMapPage() {
  const { model, evaluated, apply, lastError, clearError } = useModel();
  const [selectedLoop, setSelectedLoop] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [edgeDetails, setEdgeDetails] = useState(false);
  const [loopDetails, setLoopDetails] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [connect, setConnect] = useState<{ active: boolean; sourceId: string | null }>({ active: false, sourceId: null });
  /** Review filter: list only the connections still waiting to be classified. */
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Which control made the last commit, so lastError is shown next to it. */
  const [errorOwner, setErrorOwner] = useState<string | null>(null);
  const narrow = useNarrow();

  const commit = useCallback(
    (owner: string, mutation: ModelMutation): boolean => {
      setErrorOwner(owner);
      return apply(mutation);
    },
    [apply],
  );
  const errorFor = useCallback((owner: string) => (errorOwner === owner && lastError ? lastError : null), [errorOwner, lastError]);

  const editingId = editor.kind === "edit" ? editor.id : null;
  const editing = useMemo(() => (model && editingId ? (model.relationships.find((r) => r.id === editingId) ?? null) : null), [model, editingId]);

  const highlight = useMemo(() => (evaluated ? highlightFor(evaluated, { loopId: selectedLoop, nodeId: selectedNode, edgeId: editing?.id ?? selectedEdge }) : { edges: new Set<string>(), nodes: new Set<string>() }), [evaluated, selectedLoop, selectedNode, selectedEdge, editing]);

  if (!model || !evaluated) return <Loading />;
  const { allRelationships, variables, variableById, loops, unclassifiedRelationshipCount } = evaluated;
  const counts = mapCounts(evaluated);
  const shownIds = new Set(allRelationships.map((r) => r.id));
  const orphaned = model.relationships.filter((r) => !shownIds.has(r.id));
  const nameOf = (id: string) => variableById.get(id)?.name ?? id;
  const filtering = unclassifiedOnly && unclassifiedRelationshipCount > 0;
  const listed = filtering ? allRelationships.filter((r) => r.kind === "unclassified") : allRelationships;
  const selectedRel = selectedEdge ? (allRelationships.find((r) => r.id === selectedEdge) ?? null) : null;
  const relationshipById = new Map(allRelationships.map((r) => [r.id, r]));

  const openEditor = (id: string) => {
    clearError();
    setEditor({ kind: "edit", id });
    setEditOpen(true);
  };
  const startCreate = (sourceId?: string, targetId?: string) => {
    clearError();
    setEditor({ kind: "create", sourceId, targetId });
    setEditOpen(true);
  };
  const closeEditor = () => {
    clearError();
    setEditor({ kind: "closed" });
  };
  const startConnect = () => {
    setConnect({ active: true, sourceId: null });
    setSelectedNode(null);
    setSelectedLoop(null);
    setSelectedEdge(null);
  };
  const cancelConnect = () => setConnect({ active: false, sourceId: null });

  const handleNodeClick = (id: string) => {
    if (connect.active) {
      if (!connect.sourceId) {
        setConnect({ active: true, sourceId: id });
        return;
      }
      if (connect.sourceId === id) {
        setConnect({ active: true, sourceId: null });
        return;
      }
      startCreate(connect.sourceId, id);
      setConnect({ active: false, sourceId: null });
      return;
    }
    setSelectedLoop(null);
    setSelectedEdge(null);
    setSelectedNode((prev) => (prev === id ? null : id));
  };
  /** A clicked connection is shown read-only first; editing needs "Edit connection". */
  const handleEdgeClick = (id: string) => {
    setSelectedLoop(null);
    setSelectedNode(null);
    setEdgeDetails(false);
    setSelectedEdge((prev) => (prev === id ? null : id));
  };
  const selectLoop = (id: string | null) => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setSelectedLoop(id);
  };

  const editorKey = editor.kind === "edit" ? `edit:${editor.id}` : editor.kind === "create" ? `create:${editor.sourceId ?? ""}:${editor.targetId ?? ""}` : "closed";
  const unclassified = unclassifiedNotice(unclassifiedRelationshipCount);
  const orphans = orphanNotice(orphaned.length);

  return (
    <div>
      <header className="mx-auto mb-6 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Map</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">See what seems connected in your system.</p>
        <p className="mt-1 text-sm text-muted">{MAP_EPISTEMIC}</p>
        {unclassified ? (
          <p className="mt-4 text-[15px] leading-relaxed" data-testid="unclassified-notice">
            {unclassified}{" "}
            <button
              type="button"
              className={ACTION}
              onClick={() => {
                setUnclassifiedOnly(true);
                setEditOpen(true);
              }}
            >
              Review connections →
            </button>
          </p>
        ) : null}
        {orphans ? (
          <div className="mt-4 rounded-xl border border-warn/50 bg-warn-soft px-4 py-3 text-[15px] leading-relaxed" role="alert" data-testid="orphan-warning">
            <p>{orphans}</p>
            <ul className="mt-2 space-y-1 text-sm">
              {orphaned.map((r) => {
                const rowError = errorFor(`orphan:${r.id}`);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      {nameOf(r.sourceVariableId)} → {nameOf(r.targetVariableId)}
                    </span>
                    <span className="font-mono text-xs text-muted">{r.id}</span>
                    <button type="button" className="text-sm text-neg hover:underline" onClick={() => commit(`orphan:${r.id}`, (m) => mutations.removeRelationship(m, r.id))}>
                      Remove
                    </button>
                    {rowError ? (
                      <span className="text-sm text-neg" role="alert">
                        {rowError}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </header>

      <section className="rounded-xl border border-border/70 bg-surface p-3 md:p-4" data-testid="map">
        {connect.active ? (
          <p className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-desired" role="status">
            <span>{connect.sourceId ? `Source: ${nameOf(connect.sourceId)}. Now click the target variable (click the source again to unpick it).` : "Connect mode: click the source variable on the diagram."}</span>
            <button type="button" className={TOGGLE} onClick={cancelConnect}>
              Cancel connect
            </button>
          </p>
        ) : null}
        <NetworkDiagram
          variables={variables}
          relationships={allRelationships}
          highlightEdgeIds={highlight.edges}
          highlightNodeIds={highlight.nodes}
          selectedEdgeId={editing?.id ?? selectedEdge}
          pendingSourceId={connect.sourceId}
          connectMode={connect.active}
          showIsolatedNodes={connect.active}
          showLagLabels={!narrow}
          onNodeClick={handleNodeClick}
          onEdgeClick={connect.active ? undefined : handleEdgeClick}
        />
        <p className="mt-2 text-sm text-muted">{connect.active ? "Every variable is shown while connecting, including those without connections yet." : `${MAP_READING_HINT} Tap a variable or a connection to read about it.`}</p>
      </section>

      <div className="mx-auto mt-8 max-w-2xl space-y-10">
        {selectedNode && !selectedRel ? (
          <section data-testid="connected-with">
            <h2 className="text-lg font-semibold tracking-tight">Connected with {nameOf(selectedNode)}</h2>
            {connectionsOf(allRelationships, selectedNode).length === 0 ? (
              <p className="mt-2 text-[15px] text-muted">No recorded connection yet.</p>
            ) : (
              <ul className="mt-1 divide-y divide-border/70">
                {connectionsOf(allRelationships, selectedNode).map((r) => {
                  const note = connectionUseNote(r);
                  return (
                    <li key={r.id} className="py-3" data-connection={r.id}>
                      <p className="text-sm text-muted">{KIND_LABELS[r.kind]}</p>
                      <p className="text-[15px] leading-relaxed">{connectionSentence(r, nameOf)}</p>
                      {note ? <p className="text-sm text-muted">{note}</p> : null}
                      <button type="button" className={`mt-1 ${TOGGLE}`} onClick={() => handleEdgeClick(r.id)}>
                        Read this connection
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {selectedRel ? (
          <section className="rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="connection" data-connection={selectedRel.id}>
            <p className="text-sm text-muted">Connection</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{connectionTitle(selectedRel, nameOf)}</h2>
            <p className="mt-1 text-sm text-muted">{KIND_LABELS[selectedRel.kind]}</p>
            <p className="mt-3 text-[15px] leading-relaxed">{connectionSentence(selectedRel, nameOf)}</p>
            {selectedRel.explanation ? <p className="mt-2 text-[15px] leading-relaxed text-muted">{selectedRel.explanation}</p> : null}
            {selectedRel.lag.value > 0 ? <p className="mt-2 text-[15px] leading-relaxed">Recorded with a lag of about {formatLag(selectedRel.lag)}.</p> : null}
            {connectionUseNote(selectedRel) ? <p className="mt-2 text-sm text-muted">{connectionUseNote(selectedRel)}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button type="button" className={PRIMARY} onClick={() => openEditor(selectedRel.id)} data-testid="edit-connection">
                Edit connection
              </button>
              <button type="button" className={TOGGLE} aria-expanded={edgeDetails} onClick={() => setEdgeDetails((x) => !x)} data-testid="connection-details-toggle">
                {edgeDetails ? "Hide details" : "Details"}
              </button>
              <button type="button" className={TOGGLE} onClick={() => setSelectedEdge(null)}>
                Close
              </button>
            </div>
            {edgeDetails ? (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-sm" data-testid="connection-details">
                <dt className="text-muted">What this kind means</dt>
                <dd>{KIND_MEANINGS[selectedRel.kind]}</dd>
                <dt className="text-muted">Direction</dt>
                <dd>{selectedRel.direction === "negative" ? "negative: source up → target down" : "positive: source up → target up"}</dd>
                <dt className="text-muted">Strength</dt>
                <dd className="tabular-nums">
                  {selectedRel.strength.toFixed(2)} <span className="text-muted">— {STRENGTH_NOTE}</span>
                </dd>
                <dt className="text-muted">Confidence</dt>
                <dd>
                  <ConfidenceBadge confidence={selectedRel.confidence} />
                </dd>
                <dt className="text-muted">Source</dt>
                <dd>
                  <SourceBadge sourceType={selectedRel.sourceType} />
                </dd>
                <dt className="text-muted">Lag</dt>
                <dd className="tabular-nums">
                  {formatLag(selectedRel.lag)} <span className="text-muted">({horizonOfLag(selectedRel.lag)})</span>
                </dd>
                <dt className="text-muted">Used in feedback patterns</dt>
                <dd>{selectedRel.enabled && selectedRel.participatesInDynamics ? "yes (enabled and taking part in dynamics)" : selectedRel.enabled ? "no (enabled, not taking part in dynamics)" : "no (switched off)"}</dd>
                <dt className="text-muted">Linked observations</dt>
                <dd>{(evaluated.observations.byRelationship.get(selectedRel.id) ?? []).length === 0 ? "none" : (evaluated.observations.byRelationship.get(selectedRel.id) ?? []).map((o) => `“${o.statement}”`).join("; ")}</dd>
                {selectedRel.notes ? (
                  <>
                    <dt className="text-muted">Notes</dt>
                    <dd>{selectedRel.notes}</dd>
                  </>
                ) : null}
                <dt className="text-muted">Stored kind</dt>
                <dd>
                  <code className="text-xs">{selectedRel.kind}</code> <span className="text-muted">({RELATIONSHIP_KIND_META[selectedRel.kind].meaning})</span>
                </dd>
              </dl>
            ) : null}
          </section>
        ) : null}

        <section data-testid="patterns">
          <h2 className="text-lg font-semibold tracking-tight">Feedback patterns</h2>
          <p className="mt-1 text-sm text-muted">Closed chains of connections that feed back on themselves, read from the connections in use. Each is a working model to test, never established fact.</p>
          {loops.length === 0 ? (
            <p className="mt-2 text-[15px] text-muted">No closed chain among the connections in use yet.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border/70">
              {loops.map((l) => {
                const active = selectedLoop === l.id;
                return (
                  <li key={l.id} className="py-3" data-loop={l.id} data-selected={active ? "true" : "false"}>
                    <button type="button" className="text-left" aria-pressed={active} onClick={() => selectLoop(active ? null : l.id)}>
                      <span className="block text-sm text-muted">{patternLabel(l.polarity)}</span>
                      <span className="block text-[15px] leading-relaxed">{loopChainSentence(l, nameOf)}</span>
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                      {!active ? (
                        <button type="button" className={TOGGLE} onClick={() => selectLoop(l.id)}>
                          Show on map
                        </button>
                      ) : (
                        <button type="button" className={TOGGLE} onClick={() => selectLoop(null)}>
                          Clear
                        </button>
                      )}
                      <button type="button" className={TOGGLE} aria-expanded={loopDetails === l.id} onClick={() => setLoopDetails((x) => (x === l.id ? null : l.id))}>
                        {loopDetails === l.id ? "Hide details" : "Details"}
                      </button>
                    </div>
                    {loopDetails === l.id ? (
                      <div className="mt-2" data-testid="loop-details">
                        <LoopList loops={[l]} variableById={variableById} relationshipById={relationshipById} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section data-testid="edit-map">
          <button type="button" className={TOGGLE} aria-expanded={editOpen} onClick={() => setEditOpen((x) => !x)} data-testid="edit-map-toggle">
            {editOpen ? "Hide map editing" : "Edit map"}
          </button>
          {editOpen ? (
            <div className="mt-3 space-y-5">
              <JudgmentBanner />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={QUIET} onClick={() => startCreate()} data-testid="new-relationship">
                  New relationship
                </button>
                {!connect.active ? (
                  <button type="button" className={QUIET} onClick={startConnect} data-testid="connect-on-diagram">
                    Connect on diagram
                  </button>
                ) : null}
                {unclassifiedRelationshipCount > 0 ? (
                  <button type="button" className={QUIET} aria-pressed={unclassifiedOnly} onClick={() => setUnclassifiedOnly((v) => !v)} data-testid="unclassified-filter">
                    {unclassifiedOnly ? "Show every connection" : "Show only unclassified"}
                  </button>
                ) : null}
              </div>

              {editor.kind !== "closed" && !(editor.kind === "edit" && !editing) ? (
                <div className="rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="relationship-editor">
                  <p className="text-sm text-muted">{editor.kind === "edit" ? "Edit connection" : "New connection"}</p>
                  <div className="mt-2">
                    <RelationshipEditor key={editorKey} relationship={editing} initialSourceId={editor.kind === "create" ? editor.sourceId : undefined} initialTargetId={editor.kind === "create" ? editor.targetId : undefined} variables={variables} variableById={variableById} linkedObservations={editing ? (evaluated.observations.byRelationship.get(editing.id) ?? []) : []} commit={commit} errorFor={errorFor} clearError={clearError} allocateId={() => mutations.nextId(model, "rel")} onCreated={(id) => openEditor(id)} onDeleted={closeEditor} onClose={closeEditor} />
                  </div>
                </div>
              ) : null}

              <div data-testid="relationships-table">
                <p className="text-sm text-muted">
                  All connections · {counts.stored} stored · {counts.inDynamics} in dynamics · {counts.excluded} excluded · {counts.disabled} disabled
                </p>
                {filtering ? (
                  <p className="mt-1 text-sm text-muted" role="status">
                    Showing only the {listed.length} unclassified connection{listed.length === 1 ? "" : "s"}. Open one to choose its kind.
                  </p>
                ) : null}
                {allRelationships.length === 0 ? (
                  <p className="mt-2 text-[15px] text-muted">No relationships stored yet.</p>
                ) : (
                  <div className="mt-2 max-h-[36rem] overflow-x-auto overflow-y-auto">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>From → To</th>
                          <th>Kind</th>
                          <th>Dynamics</th>
                          <th>Sign</th>
                          <th>Strength</th>
                          <th>Lag</th>
                          <th>Provenance</th>
                          <th>Enabled</th>
                        </tr>
                      </thead>
                      <tbody>
                        {listed.map((r) => {
                          const selected = editing?.id === r.id;
                          const hl = highlight.edges.has(r.id);
                          const rowError = errorFor(`table:${r.id}`);
                          const inDynamics = r.enabled && r.participatesInDynamics;
                          return (
                            <tr key={r.id} className={`${selected ? "bg-accent-soft" : hl ? "bg-background" : ""} ${r.enabled ? "" : "text-muted"}`}>
                              <td>
                                <button type="button" className="text-left font-medium hover:underline" aria-pressed={selected} onClick={() => openEditor(r.id)}>
                                  {nameOf(r.sourceVariableId)} → {nameOf(r.targetVariableId)}
                                </button>
                                {!r.enabled ? <span className="ml-2 inline-block rounded border border-border bg-background px-1.5 py-0.5 text-xs">disabled</span> : null}
                                {r.explanation ? <div className="max-w-xs text-xs text-muted">{r.explanation}</div> : null}
                              </td>
                              <td>
                                <span title={RELATIONSHIP_KIND_META[r.kind].meaning} className={`inline-block rounded px-1.5 py-0.5 text-xs ${r.kind === "unclassified" ? "bg-warn-soft text-warn" : "border border-border bg-background"}`}>
                                  {RELATIONSHIP_KIND_META[r.kind].label}
                                </span>
                              </td>
                              <td className="text-center">
                                <span role="img" aria-label={inDynamics ? "takes part in dynamics" : "excluded from dynamics"} title={inDynamics ? "takes part in dynamics" : "excluded from dynamics"} className={inDynamics ? "text-desired" : "text-muted"}>
                                  {inDynamics ? "✓" : "—"}
                                </span>
                              </td>
                              <td className={r.direction === "negative" ? "text-warn" : "text-accent"} title={r.direction === "negative" ? "source up → target down" : "source up → target up"}>
                                {r.direction === "negative" ? "−" : "+"}
                              </td>
                              <td className="tabular-nums">{r.strength.toFixed(2)}</td>
                              <td>
                                <div className="tabular-nums">{formatLag(r.lag)}</div>
                                <div className="text-xs text-muted">{horizonOfLag(r.lag)}</div>
                              </td>
                              <td>
                                <div className="flex flex-col items-start gap-1">
                                  <SourceBadge sourceType={r.sourceType} />
                                  <ConfidenceBadge confidence={r.confidence} />
                                </div>
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={r.enabled}
                                  aria-label={`Enable ${nameOf(r.sourceVariableId)} → ${nameOf(r.targetVariableId)}`}
                                  onChange={(e) => {
                                    const enabled = e.target.checked;
                                    commit(`table:${r.id}`, (m) => mutations.setRelationshipEnabled(m, r.id, enabled));
                                  }}
                                />
                                {rowError ? (
                                  <div className="mt-1 text-xs text-neg" role="alert">
                                    {rowError}
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>

        <section data-testid="about" className="text-sm text-muted">
          <button type="button" className={TOGGLE} aria-expanded={aboutOpen} onClick={() => setAboutOpen((x) => !x)} data-testid="about-toggle">
            {aboutOpen ? "Hide" : "About this map"}
          </button>
          {aboutOpen ? (
            <div className="mt-2 space-y-3" data-testid="about-details">
              <ul className="space-y-0.5 tabular-nums">
                <li>Connections stored: {counts.stored}</li>
                <li>In dynamics (enabled; feedback patterns read these): {counts.inDynamics}</li>
                <li>Excluded (enabled, not in dynamics): {counts.excluded}</li>
                <li>Disabled (kept, excluded from feedback patterns): {counts.disabled}</li>
                <li>Feedback patterns detected: {counts.loops}</li>
              </ul>
              <p>Only a causal hypothesis or an opted-in definitional dependency can take part in dynamics. Feedback patterns are detected from the enabled connections in dynamics, never stored, so editing a connection changes them. Reinforcing = an even number of negative connections (A9). Pressure = mean connection strength × mean normalised gap of the pattern&apos;s variables (A10): a diagnostic index of how actively a pattern is reproducing the current state, not a rate. A pattern&apos;s status is the status of its hypothesis; &quot;accepted&quot; is a working reading, not established fact. {STRENGTH_NOTE}</p>
              <p>The full legend sits under the map: solid blue = positive (same direction); dashed amber = negative (opposite direction); thin dotted grey = enabled but not in dynamics (unclassified, association, constraint, or definitional not opted in); lighter dotted = disabled; the small label on a connection is its lag (none when immediate); a dashed circle is a calculated variable.</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
