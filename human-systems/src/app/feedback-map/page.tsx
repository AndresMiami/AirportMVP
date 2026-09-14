"use client";
import { useCallback, useMemo, useState } from "react";
import { formatLag, horizonOfLag } from "@/calculations/lag";
import { LoopList } from "@/components/loop-list";
import { useModel, type ModelMutation } from "@/components/model-provider";
import { NetworkDiagram } from "@/components/network-diagram";
import { JudgmentBanner, RELATIONSHIP_KIND_META, RelationshipEditor } from "@/components/relationship-editor";
import { Card, ConfidenceBadge, Loading, Note, PageHeader, SourceBadge, Stat } from "@/components/ui";
import * as mutations from "@/services/mutations";

type EditorState = { kind: "closed" } | { kind: "create"; sourceId?: string; targetId?: string } | { kind: "edit"; id: string };

const BTN = "rounded border border-border bg-background px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50";
const BTN_PRIMARY = "rounded bg-accent text-white px-3 py-1.5 text-sm disabled:opacity-50";

export default function FeedbackMapPage() {
  const { model, evaluated, apply, lastError, clearError } = useModel();
  const [selectedLoop, setSelectedLoop] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [connect, setConnect] = useState<{ active: boolean; sourceId: string | null }>({ active: false, sourceId: null });
  /** Review filter: list only the edges still waiting to be classified. */
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);
  /** Which control made the last commit, so lastError is shown next to it. */
  const [errorOwner, setErrorOwner] = useState<string | null>(null);

  const commit = useCallback(
    (owner: string, mutation: ModelMutation): boolean => {
      setErrorOwner(owner);
      return apply(mutation);
    },
    [apply],
  );
  const errorFor = useCallback((owner: string) => (errorOwner === owner && lastError ? lastError : null), [errorOwner, lastError]);

  const editingId = editor.kind === "edit" ? editor.id : null;
  const editing = useMemo(
    () => (model && editingId ? (model.relationships.find((r) => r.id === editingId) ?? null) : null),
    [model, editingId],
  );

  const highlight = useMemo(() => {
    const edges = new Set<string>();
    const nodes = new Set<string>();
    if (!evaluated) return { edges, nodes };
    if (selectedLoop) {
      const l = evaluated.loops.find((x) => x.id === selectedLoop);
      for (const id of l?.edgeIds ?? []) edges.add(id);
      for (const id of l?.variableIds ?? []) nodes.add(id);
    } else if (selectedNode) {
      nodes.add(selectedNode);
      for (const r of evaluated.allRelationships) {
        if (r.sourceVariableId === selectedNode || r.targetVariableId === selectedNode) {
          edges.add(r.id);
          nodes.add(r.sourceVariableId);
          nodes.add(r.targetVariableId);
        }
      }
    }
    if (editing) {
      edges.add(editing.id);
      nodes.add(editing.sourceVariableId);
      nodes.add(editing.targetVariableId);
    }
    return { edges, nodes };
  }, [evaluated, selectedLoop, selectedNode, editing]);

  if (!model || !evaluated) return <Loading />;
  const {
    allRelationships,
    relationships,
    variables,
    variableById,
    loops,
    disabledRelationshipCount,
    nonDynamicsRelationshipCount,
    unclassifiedRelationshipCount,
  } = evaluated;
  const shownIds = new Set(allRelationships.map((r) => r.id));
  const orphaned = model.relationships.filter((r) => !shownIds.has(r.id));
  const nameOf = (id: string) => variableById.get(id)?.name ?? id;
  const filtering = unclassifiedOnly && unclassifiedRelationshipCount > 0;
  const listed = filtering ? allRelationships.filter((r) => r.kind === "unclassified") : allRelationships;

  const openEdge = (id: string) => {
    clearError();
    setEditor({ kind: "edit", id });
    setSelectedNode(null);
    setSelectedLoop(null);
  };
  const startCreate = (sourceId?: string, targetId?: string) => {
    clearError();
    setEditor({ kind: "create", sourceId, targetId });
  };
  const closeEditor = () => {
    clearError();
    setEditor({ kind: "closed" });
  };
  const startConnect = () => {
    setConnect({ active: true, sourceId: null });
    setSelectedNode(null);
    setSelectedLoop(null);
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
    setSelectedNode((prev) => (prev === id ? null : id));
  };

  const editorKey =
    editor.kind === "edit" ? `edit:${editor.id}` : editor.kind === "create" ? `create:${editor.sourceId ?? ""}:${editor.targetId ?? ""}` : "closed";

  return (
    <div>
      <PageHeader
        title="Relationships / feedback map"
        lede="Directed edges between variables. Each edge says what it claims (its kind); only causal hypotheses and opted-in definitional dependencies take part in dynamics. Loops are detected from the enabled edges in dynamics, never stored, so editing an edge changes the loops. Edge strength is a 0–1 judgment of influence chosen by the person, not a measured elasticity."
      />

      {unclassifiedRelationshipCount > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
          <span>
            {unclassifiedRelationshipCount} relationship{unclassifiedRelationshipCount === 1 ? " is" : "s are"} unclassified and take
            {unclassifiedRelationshipCount === 1 ? "s" : ""} no part in loops until you classify {unclassifiedRelationshipCount === 1 ? "it" : "them"}
          </span>
          <button type="button" className={BTN} aria-pressed={unclassifiedOnly} onClick={() => setUnclassifiedOnly((v) => !v)}>
            {unclassifiedOnly ? "Show every edge" : "Show only unclassified edges"}
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-4">
        <Stat label="Edges stored" value={allRelationships.length} />
        <Stat label="In dynamics" value={relationships.length} tone="current" sub="enabled, loops read these" />
        <Stat label="Excluded" value={nonDynamicsRelationshipCount} sub="enabled, not in dynamics" />
        <Stat label="Disabled" value={disabledRelationshipCount} sub="kept, excluded from loops" />
        <Stat label="Loops detected" value={loops.length} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button type="button" className={BTN_PRIMARY} onClick={() => startCreate()}>
            New relationship
          </button>
          {connect.active ? (
            <>
              <span className="text-sm text-desired" role="status">
                {connect.sourceId
                  ? `Source: ${nameOf(connect.sourceId)}. Now click the target variable (click the source again to unpick it).`
                  : "Connect mode: click the source variable on the diagram."}
              </span>
              <button type="button" className={BTN} onClick={cancelConnect}>
                Cancel connect
              </button>
            </>
          ) : (
            <button type="button" className={BTN} onClick={startConnect}>
              Connect on diagram
            </button>
          )}
        </div>
        <NetworkDiagram
          variables={variables}
          relationships={allRelationships}
          highlightEdgeIds={highlight.edges}
          highlightNodeIds={highlight.nodes}
          selectedEdgeId={editing?.id ?? null}
          pendingSourceId={connect.sourceId}
          connectMode={connect.active}
          showIsolatedNodes={connect.active}
          onNodeClick={handleNodeClick}
          onEdgeClick={connect.active ? undefined : openEdge}
        />
        <p className="text-xs text-muted mt-2">
          {connect.active
            ? "Every variable is shown while connecting, including those without edges yet. Edges are not clickable in connect mode."
            : "Click a node to see its edges, click an edge or its lag label to edit it, or pick a loop below to trace it. Hover an edge for its explanation."}
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 mt-4 items-start">
        <div className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          <Card title="Relationship editor">
            {editor.kind === "closed" || (editor.kind === "edit" && !editing) ? (
              <div className="space-y-3">
                <JudgmentBanner />
                <p className="text-sm text-muted">
                  Select an edge in the diagram or in the table to edit it, or add a new relationship.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN_PRIMARY} onClick={() => startCreate()}>
                    New relationship
                  </button>
                  {!connect.active ? (
                    <button type="button" className={BTN} onClick={startConnect}>
                      Connect on diagram
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <RelationshipEditor
                key={editorKey}
                relationship={editing}
                initialSourceId={editor.kind === "create" ? editor.sourceId : undefined}
                initialTargetId={editor.kind === "create" ? editor.targetId : undefined}
                variables={variables}
                variableById={variableById}
                linkedObservations={editing ? (evaluated.observations.byRelationship.get(editing.id) ?? []) : []}
                commit={commit}
                errorFor={errorFor}
                clearError={clearError}
                allocateId={() => mutations.nextId(model, "rel")}
                onCreated={(id) => openEdge(id)}
                onDeleted={closeEditor}
                onClose={closeEditor}
              />
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card
            title={`Edges (${allRelationships.length} stored · ${relationships.length} in dynamics · ${nonDynamicsRelationshipCount} excluded · ${disabledRelationshipCount} disabled)`}
          >
            <JudgmentBanner />
            {filtering ? (
              <p className="text-xs text-muted mt-3" role="status">
                Showing only the {listed.length} unclassified edge{listed.length === 1 ? "" : "s"}. Open one to choose its kind.
              </p>
            ) : null}
            {allRelationships.length === 0 ? (
              <p className="text-sm text-muted mt-3">No relationships stored yet.</p>
            ) : (
              <div className="overflow-x-auto max-h-[36rem] overflow-y-auto mt-3">
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
                            <button
                              type="button"
                              className="text-left font-medium hover:underline"
                              aria-pressed={selected}
                              onClick={() => openEdge(r.id)}
                            >
                              {nameOf(r.sourceVariableId)} → {nameOf(r.targetVariableId)}
                            </button>
                            {!r.enabled ? (
                              <span className="ml-2 inline-block rounded border border-border bg-background px-1.5 py-0.5 text-xs">disabled</span>
                            ) : null}
                            {r.explanation ? <div className="text-xs text-muted max-w-xs">{r.explanation}</div> : null}
                          </td>
                          <td>
                            <span
                              title={RELATIONSHIP_KIND_META[r.kind].meaning}
                              className={`inline-block rounded px-1.5 py-0.5 text-xs ${r.kind === "unclassified" ? "bg-warn-soft text-warn" : "bg-background border border-border"}`}
                            >
                              {RELATIONSHIP_KIND_META[r.kind].label}
                            </span>
                          </td>
                          <td className="text-center">
                            <span
                              role="img"
                              aria-label={inDynamics ? "takes part in dynamics" : "excluded from dynamics"}
                              title={inDynamics ? "takes part in dynamics" : "excluded from dynamics"}
                              className={inDynamics ? "text-desired" : "text-muted"}
                            >
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
                            <div className="flex flex-col gap-1 items-start">
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
                              <div className="text-xs text-neg mt-1" role="alert">
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
            {orphaned.length > 0 ? (
              <div className="mt-3 space-y-2">
                <Note tone="warn">
                  {orphaned.length} stored edge{orphaned.length > 1 ? "s" : ""} reference a variable that no longer exists and take no part in the map.
                </Note>
                <ul className="space-y-1 text-sm">
                  {orphaned.map((r) => {
                    const rowError = errorFor(`orphan:${r.id}`);
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted">{r.id}</span>
                        <span>
                          {nameOf(r.sourceVariableId)} → {nameOf(r.targetVariableId)}
                        </span>
                        <button
                          type="button"
                          className="text-xs text-neg hover:underline"
                          onClick={() => commit(`orphan:${r.id}`, (m) => mutations.removeRelationship(m, r.id))}
                        >
                          Delete
                        </button>
                        {rowError ? (
                          <span className="text-xs text-neg" role="alert">
                            {rowError}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card title={`Detected loops (${loops.length})`}>
            <LoopList
              loops={loops}
              variableById={variableById}
              selected={selectedLoop}
              onSelect={(id) => {
                setSelectedNode(null);
                setSelectedLoop(id);
              }}
            />
            <div className="mt-3">
              <Note>
                Loops use enabled edges that take part in dynamics only (causal hypotheses and opted-in definitional dependencies). Reinforcing = even number of negative edges (A9). Pressure = mean edge strength × mean normalised gap of the loop&apos;s variables (A10): a diagnostic index of how actively a loop is reproducing the current state, not a rate. A loop&apos;s status is the status of its hypothesis; &quot;accepted&quot; is a working reading, not established fact.
              </Note>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
