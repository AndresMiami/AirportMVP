/**
 * Exhaustive mechanical diff between two models: every top-level key,
 * id-keyed collections row by row (variables include their histories, so a
 * new entry is a "modified" variable), domain collections per name, and
 * singletons (profile fields, attractors, weights) as one row each. This
 * diff is the ground truth for the review card.
 */
import type { SystemModel } from "@/types";
import { canonicalJSON } from "./revision";
import type { EntityChange } from "./types";

type Row = { id: string };
const byId = (rows: readonly Row[]) => new Map(rows.map((r) => [r.id, r]));

function diffRows(collection: string, before: readonly Row[], after: readonly Row[], out: EntityChange[]): void {
  const b = byId(before);
  const a = byId(after);
  for (const [id, row] of b) {
    if (!a.has(id)) out.push({ collection, id, op: "removed", before: row, after: undefined });
    else if (canonicalJSON(row) !== canonicalJSON(a.get(id))) out.push({ collection, id, op: "modified", before: row, after: a.get(id) });
  }
  for (const [id, row] of a) if (!b.has(id)) out.push({ collection, id, op: "added", before: undefined, after: row });
}

function diffSingleton(collection: string, before: unknown, after: unknown, out: EntityChange[]): void {
  if (canonicalJSON(before) !== canonicalJSON(after)) out.push({ collection, id: collection, op: "modified", before, after });
}

export function entityDiff(before: SystemModel, after: SystemModel): EntityChange[] {
  const out: EntityChange[] = [];
  const { members: bMembers, ...bProfile } = before.profile;
  const { members: aMembers, ...aProfile } = after.profile;
  diffSingleton("profile", bProfile, aProfile, out);
  diffRows("profile.members", bMembers, aMembers, out);
  diffRows("variables", before.variables, after.variables, out);
  for (const name of new Set([...Object.keys(before.collections), ...Object.keys(after.collections)])) {
    diffRows(`collections.${name}`, before.collections[name]?.items ?? [], after.collections[name]?.items ?? [], out);
    diffSingleton(`collections.${name}.envelope`, { origin: before.collections[name]?.origin, note: before.collections[name]?.note }, { origin: after.collections[name]?.origin, note: after.collections[name]?.note }, out);
  }
  diffRows("relationships", before.relationships, after.relationships, out);
  diffRows("events", before.events, after.events, out);
  diffSingleton("loopAnnotations", before.loopAnnotations, after.loopAnnotations, out);
  diffRows("constraints", before.constraints, after.constraints, out);
  diffRows("actions", before.actions, after.actions, out);
  diffRows("observations", before.observations, after.observations, out);
  diffRows("hypotheses", before.hypotheses, after.hypotheses, out);
  diffRows("signatures", before.signatures, after.signatures, out);
  diffSingleton("utilityWeights", before.utilityWeights, after.utilityWeights, out);
  diffSingleton("currentAttractor", before.currentAttractor, after.currentAttractor, out);
  diffSingleton("desiredAttractor", before.desiredAttractor, after.desiredAttractor, out);
  // identity and schema fields never change through a mutation; if they did, say so
  diffSingleton("identity", { schemaVersion: before.schemaVersion, id: before.id, domainDefinitionId: before.domainDefinitionId, domainDefinitionVersion: before.domainDefinitionVersion, createdAt: before.createdAt }, { schemaVersion: after.schemaVersion, id: after.id, domainDefinitionId: after.domainDefinitionId, domainDefinitionVersion: after.domainDefinitionVersion, createdAt: after.createdAt }, out);
  return out;
}

/** Words for a row a step did not name (a derived shell, a cascade). */
export function describeExtraChange(c: EntityChange): string {
  const name = (row: unknown) => (row && typeof row === "object" && "name" in row ? String((row as { name: unknown }).name) : row && typeof row === "object" && "label" in row ? String((row as { label: unknown }).label) : row && typeof row === "object" && "statement" in row ? String((row as { statement: unknown }).statement) : c.id);
  const what = c.collection === "profile.members" ? "subject" : c.collection.replace(/^collections\./, "").replace(/s$/, "");
  return `${c.op === "added" ? "Adds" : c.op === "removed" ? "Removes" : "Changes"} ${what} ${name(c.after ?? c.before)}.`;
}
