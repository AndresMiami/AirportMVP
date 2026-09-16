/**
 * localStorage store holding several models under one key. Every model is
 * passed through model/migrations on load, so a record saved by an older
 * build is upgraded (or rejected with a reason) before it reaches the UI.
 * The v1 single-model key is imported once and then removed.
 *
 * STORAGE SAFETY (Checkpoint 3.1): unreadable != empty. Data this build
 * cannot understand is never treated as absent and never overwritten or
 * deleted by anything automatic:
 *   - an ABSENT primary key is an empty store; a PRESENT key that is not
 *     a readable store envelope (bad JSON, not an object, malformed
 *     models/backups/activeId) is a typed StorageError — every read AND
 *     every write refuses while it stands, bytes untouched;
 *   - a raw model record that fails migration still COUNTS as stored
 *     (hasStoredModels) and is reported (unreadable), never replaced:
 *     save() refuses to overwrite it;
 *   - the legacy single-model key is imported only when it parses, has a
 *     usable id and collides with nothing; it is removed only AFTER the
 *     primary write succeeded. A failed import leaves its bytes intact and
 *     surfaces a StorageError.
 * Recovery, export or deletion of unreadable data is an explicit tool for
 * later; this layer only preserves and refuses.
 */
import { migrateModel, migrationOptionsFor } from "@/model/migrations";
import { SystemModelSchema, type SystemModel } from "@/types";
import { summarize } from "./memory-repository";
import type { GuardedSaveResult, ModelRepository, ModelSummary } from "./model-repository";

export const STORAGE_KEY = "human-systems.store.v2";
export const LEGACY_V1_KEY = "human-systems.model.v1";

/** Minimal storage interface so tests can pass a fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoreShape {
  activeId: string | null;
  /** Raw JSON per model id; migrated on read, written in current shape. */
  models: Record<string, unknown>;
  /** Pre-migration copies, by model id then schema version the copy had.
   *  Kept until the person deletes them; never read by the app. */
  backups: Record<string, Record<string, unknown>>;
}

export type StorageErrorKind = "unreadable_store" | "unreadable_legacy" | "legacy_conflict" | "would_overwrite_unreadable";

/** Stored data this build cannot safely interpret. Nothing was written. */
export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export interface LoadReport {
  id: string;
  ok: boolean;
  migratedFrom: number | null;
  error?: string;
}

export class LocalStorageModelRepository implements ModelRepository {
  /** Outcome of the last read of each model, for the UI to report. */
  readonly reports = new Map<string, LoadReport>();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string = STORAGE_KEY,
    private readonly legacyKey: string = LEGACY_V1_KEY,
  ) {}

  /** The store envelope, strictly. Absent key = empty store. A present key
   *  that is not the envelope this build writes is refused, bytes kept. */
  private read(): StoreShape {
    const raw = this.storage.getItem(this.key);
    let store: StoreShape;
    if (raw === null || raw === "") {
      store = { activeId: null, models: {}, backups: {} };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new StorageError("unreadable_store", `The stored data under "${this.key}" is not valid JSON. Nothing was changed; the data is kept exactly as it is.`);
      }
      if (!isPlainObject(parsed)) throw new StorageError("unreadable_store", `The stored data under "${this.key}" is not a store (expected an object). Nothing was changed.`);
      if (!isPlainObject(parsed.models)) throw new StorageError("unreadable_store", `The stored data under "${this.key}" has no readable "models" container. Nothing was changed.`);
      if (parsed.backups !== undefined && !isPlainObject(parsed.backups)) throw new StorageError("unreadable_store", `The stored data under "${this.key}" has a malformed "backups" container. Nothing was changed.`);
      if (parsed.activeId !== undefined && parsed.activeId !== null && typeof parsed.activeId !== "string") throw new StorageError("unreadable_store", `The stored data under "${this.key}" has a malformed "activeId". Nothing was changed.`);
      for (const [id, b] of Object.entries(parsed.backups ?? {})) if (!isPlainObject(b)) throw new StorageError("unreadable_store", `The stored data under "${this.key}" has malformed backups for "${id}". Nothing was changed.`);
      store = { activeId: typeof parsed.activeId === "string" ? parsed.activeId : null, models: parsed.models, backups: (parsed.backups as StoreShape["backups"] | undefined) ?? {} };
    }
    return this.importLegacy(store);
  }

  /** One-time import of the pre-store single-model key: parse -> safe
   *  destination -> primary write -> ONLY THEN remove the legacy key. */
  private importLegacy(store: StoreShape): StoreShape {
    const legacy = this.storage.getItem(this.legacyKey);
    if (legacy === null || legacy === "") return store;
    let obj: unknown;
    try {
      obj = JSON.parse(legacy);
    } catch {
      throw new StorageError("unreadable_legacy", `The older single-model record under "${this.legacyKey}" is not valid JSON. It was kept exactly as it is; nothing was imported or deleted.`);
    }
    if (!isPlainObject(obj) || typeof obj.id !== "string" || obj.id === "") throw new StorageError("unreadable_legacy", `The older single-model record under "${this.legacyKey}" has no usable id. It was kept exactly as it is; nothing was imported or deleted.`);
    if (obj.id in store.models) throw new StorageError("legacy_conflict", `The older single-model record under "${this.legacyKey}" has the same id ("${obj.id}") as a stored system. Both were kept; neither was overwritten.`);
    const next: StoreShape = { ...store, models: { ...store.models, [obj.id]: obj }, activeId: store.activeId ?? obj.id };
    this.write(next); // throws -> the legacy key stays
    this.storage.removeItem(this.legacyKey);
    return next;
  }

  private write(store: StoreShape): void {
    this.storage.setItem(this.key, JSON.stringify(store));
  }

  private materialize(id: string, raw: unknown): SystemModel | null {
    const result = migrateModel(raw, migrationOptionsFor(raw));
    if (!result.ok) {
      this.reports.set(id, { id, ok: false, migratedFrom: null, error: result.error });
      return null;
    }
    this.reports.set(id, { id, ok: true, migratedFrom: result.migratedFrom });
    return result.model;
  }

  async list(): Promise<ModelSummary[]> {
    const store = this.read();
    const out: ModelSummary[] = [];
    for (const [id, raw] of Object.entries(store.models)) {
      const m = this.materialize(id, raw);
      if (m) out.push(summarize(m));
    }
    return out;
  }

  async load(id: string): Promise<SystemModel | null> {
    const store = this.read();
    if (!(id in store.models)) return null;
    const raw = store.models[id];
    const model = this.materialize(id, raw);
    const from = this.reports.get(id)?.migratedFrom;
    if (model && from !== null && from !== undefined) {
      // Keep the pre-migration record, then persist the upgraded shape so
      // the migration runs once. A failed migration never reaches here, so
      // the original stays untouched.
      store.backups[id] = { ...(store.backups[id] ?? {}), [String(from)]: raw };
      store.models[id] = model;
      this.write(store);
    }
    return model;
  }

  /** True when a raw record exists under `id` that this build cannot read. */
  private isUnreadableRecord(store: StoreShape, id: string): boolean {
    const raw = store.models[id];
    if (raw === undefined) return false;
    if (SystemModelSchema.safeParse(raw).success) return false;
    return !migrateModel(raw, migrationOptionsFor(raw)).ok;
  }

  async save(model: SystemModel): Promise<void> {
    const validated = SystemModelSchema.parse(model);
    const store = this.read();
    if (this.isUnreadableRecord(store, validated.id)) {
      throw new StorageError("would_overwrite_unreadable", `A stored system with id "${validated.id}" exists but cannot be read by this build; saving would overwrite it. Nothing was written.`);
    }
    store.models[validated.id] = validated;
    this.write(store);
  }

  async hasStoredModels(): Promise<boolean> {
    return Object.keys(this.read().models).length > 0;
  }

  async unreadable(): Promise<{ id: string; error: string }[]> {
    const store = this.read();
    const out: { id: string; error: string }[] = [];
    for (const [id, raw] of Object.entries(store.models)) {
      const result = migrateModel(raw, migrationOptionsFor(raw));
      if (!result.ok) out.push({ id, error: result.error });
    }
    return out;
  }

  async saveIfRevision(model: SystemModel, expectedRevision: string | null, revisionOf: (m: SystemModel | null) => string | null): Promise<GuardedSaveResult> {
    const validated = SystemModelSchema.parse(model);
    // localStorage is synchronous: read, compare and write in one turn.
    const store = this.read();
    const raw = store.models[validated.id];
    const stored = raw === undefined ? null : SystemModelSchema.safeParse(raw);
    const current = stored === null ? null : stored.success ? revisionOf(stored.data) : `unreadable:${validated.id}`;
    if (current !== expectedRevision) return { ok: false, currentRevision: current };
    store.models[validated.id] = validated;
    this.write(store);
    return { ok: true };
  }

  /** Pre-migration copies kept for a model (by the schema version they had). */
  async backupsFor(id: string): Promise<Record<string, unknown>> {
    return this.read().backups[id] ?? {};
  }

  async deleteBackups(id: string): Promise<void> {
    const store = this.read();
    delete store.backups[id];
    this.write(store);
  }

  async delete(id: string): Promise<void> {
    const store = this.read();
    delete store.models[id];
    delete store.backups[id];
    if (store.activeId === id) store.activeId = null;
    this.write(store);
  }

  async getActiveId(): Promise<string | null> {
    return this.read().activeId;
  }

  async setActiveId(id: string | null): Promise<void> {
    const store = this.read();
    store.activeId = id;
    this.write(store);
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.key);
    this.storage.removeItem(this.legacyKey);
  }
}
