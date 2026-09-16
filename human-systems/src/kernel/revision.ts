/**
 * Revision of a model: the EXACT canonical serialization of everything
 * except `updatedAt` (commit metadata). Equality of revisions is what the
 * guarded write compares, so v1 deliberately stores the long exact string
 * rather than a hash: two different models must never share a revision.
 * A compact digest can replace it later without changing the contract.
 */
import type { SystemModel } from "@/types";

/** Deterministic JSON: object keys sorted at every depth, arrays in order,
 *  undefined dropped (as JSON.stringify does). */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export type Revision = string;

/** The revision of a stored model; null for "no such model". */
export function revisionOf(model: SystemModel | null): Revision | null {
  if (!model) return null;
  const { updatedAt: _commitMetadata, ...rest } = model;
  void _commitMetadata;
  return canonicalJSON(rest);
}
