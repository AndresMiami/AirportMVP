/**
 * SOURCE SNAPSHOTS (Step 7B, research agents). A source is anything a
 * collector reads: a public data table, an exported statement, a page.
 * A snapshot is one retrieval of it, with the source's own version marker,
 * carrying items that each quote the exact supporting content and the
 * period it applies to. Snapshots are append-only: a new retrieval with
 * changed content needs a new version, and every version stays on file so
 * a review can be traced to what the source said at the time.
 *
 * The store is synchronous and separate from the canonical model (like the
 * proposal ledger): the model never contains a source, only the evidence a
 * person approved from it.
 */
import { z } from "zod";
import { contentHash } from "@/ai/hash";
import { canonicalJSON } from "@/kernel/revision";
import type { KeyValueStorage } from "@/repositories/local-storage-repository";
import { SourceTypeSchema } from "@/types";

export const SourcePeriodSchema = z
  .object({
    /** The period in the source's own words ("Q2 2026", "March 2026"). */
    text: z.string().min(1),
    /** ISO date the content applies from, when the source states one. */
    start: z.string().optional(),
    /** ISO date it applies to, for a stated range. */
    end: z.string().optional(),
  })
  .strict();

export const SourceItemSchema = z
  .object({
    /** Stable within the source across versions: a row id, a series code. */
    key: z.string().min(1),
    /** The notebook variable KEY this item measures (never an id: ids are per notebook). */
    variableKey: z.string().min(1),
    /** A member id when the item is about one member; absent = the system. */
    subjectId: z.string().optional(),
    period: SourcePeriodSchema,
    /** The number the source states, or null when the source states it is unknown. */
    value: z.number().nullable(),
    /** The ORIGINAL provenance of the content: how the source came by it. Never "ai_inferred". */
    sourceType: SourceTypeSchema.exclude(["ai_inferred"]),
    /** The exact supporting content, verbatim. */
    quote: z.string().min(1),
    /** Where in the source: a page, an anchor, a row number. */
    locator: z.string().optional(),
  })
  .strict();
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceSnapshotSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().optional(),
    /** The source's version at retrieval: an etag, a content hash, a publication date. Must change when the content changes. */
    version: z.string().min(1),
    /** ISO instant of the retrieval. */
    retrievedAt: z.string().min(1),
    items: z.array(SourceItemSchema).min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const keys = new Set<string>();
    for (const it of s.items) {
      if (keys.has(it.key)) ctx.addIssue({ code: "custom", message: `duplicate item key "${it.key}"` });
      keys.add(it.key);
    }
  });
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

export type ParsedSnapshot = { ok: true; snapshot: SourceSnapshot } | { ok: false; error: string };

/** Parse an imported file. Nothing is stored here. */
export function parseSourceSnapshot(text: string): ParsedSnapshot {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `The file is not valid JSON: ${(e as Error).message}` };
  }
  const r = SourceSnapshotSchema.safeParse(json);
  if (!r.success) return { ok: false, error: `The file is not a source snapshot: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  return { ok: true, snapshot: r.data };
}

/** The item's content as reviewed: everything a person reads, nothing about the retrieval. */
export function itemContentHash(item: SourceItem): string {
  return contentHash(canonicalJSON({ variableKey: item.variableKey, subjectId: item.subjectId ?? null, period: item.period, value: item.value, sourceType: item.sourceType, quote: item.quote }));
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export type AddSnapshotResult = { stored: true } | { stored: false; reason: "same_version_same_content" };

export interface SourceSummary {
  id: string;
  name: string;
  versions: number;
  latestVersion: string;
  latestRetrievedAt: string;
}

/** Append-only per source; synchronous because review fingerprints resolve synchronously. */
export interface SourceRepository {
  list(): SourceSummary[];
  versions(sourceId: string): SourceSnapshot[];
  current(sourceId: string): SourceSnapshot | null;
  add(snapshot: SourceSnapshot): AddSnapshotResult;
  /** BasisSources: the CURRENT content of one item, or null when the source or the item is gone. */
  itemContent(sourceId: string, itemKey: string): unknown | null;
}

function addTo(all: Record<string, SourceSnapshot[]>, snapshot: SourceSnapshot): AddSnapshotResult {
  const versions = all[snapshot.id] ?? [];
  const same = versions.find((v) => v.version === snapshot.version);
  if (same) {
    if (canonicalJSON(same.items) === canonicalJSON(snapshot.items)) return { stored: false, reason: "same_version_same_content" };
    throw new SourceError(`Version "${snapshot.version}" of source "${snapshot.id}" is already on file with different content. A changed source needs a new version marker.`);
  }
  all[snapshot.id] = [...versions, structuredClone(snapshot)];
  return { stored: true };
}
const summaries = (all: Record<string, SourceSnapshot[]>): SourceSummary[] =>
  Object.values(all)
    .filter((vs) => vs.length > 0)
    .map((vs) => ({ id: vs[0].id, name: vs.at(-1)!.name, versions: vs.length, latestVersion: vs.at(-1)!.version, latestRetrievedAt: vs.at(-1)!.retrievedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
/** The CONTENT of an item in the current version: what a person reviews.
 *  The version marker is deliberately left out, so a newer retrieval that
 *  says the same thing changes nothing; the store keeps the versions. */
const contentOf = (snapshot: SourceSnapshot | null, itemKey: string): unknown | null => {
  const item = snapshot?.items.find((i) => i.key === itemKey);
  return snapshot && item ? { name: snapshot.name, item } : null;
};

export class MemorySourceRepository implements SourceRepository {
  private all: Record<string, SourceSnapshot[]> = {};
  list() {
    return summaries(this.all);
  }
  versions(sourceId: string) {
    return (this.all[sourceId] ?? []).map((s) => structuredClone(s));
  }
  current(sourceId: string) {
    const v = this.all[sourceId]?.at(-1);
    return v ? structuredClone(v) : null;
  }
  add(snapshot: SourceSnapshot) {
    return addTo(this.all, snapshot);
  }
  itemContent(sourceId: string, itemKey: string) {
    return contentOf(this.current(sourceId), itemKey);
  }
}

export const SOURCES_KEY = "human-systems.sources.v1";

export class LocalStorageSourceRepository implements SourceRepository {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string = SOURCES_KEY,
  ) {}
  private read(): Record<string, SourceSnapshot[]> {
    const raw = this.storage.getItem(this.key);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, SourceSnapshot[]>) : {};
    } catch {
      throw new SourceError("The source store is unreadable; nothing is written until it is inspected.");
    }
  }
  list() {
    return summaries(this.read());
  }
  versions(sourceId: string) {
    return this.read()[sourceId] ?? [];
  }
  current(sourceId: string) {
    return this.read()[sourceId]?.at(-1) ?? null;
  }
  add(snapshot: SourceSnapshot) {
    const all = this.read();
    const r = addTo(all, snapshot);
    if (r.stored) this.storage.setItem(this.key, JSON.stringify(all));
    return r;
  }
  itemContent(sourceId: string, itemKey: string) {
    return contentOf(this.current(sourceId), itemKey);
  }
}
