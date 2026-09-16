/**
 * localStorage store holding several models under one key. Every model is
 * passed through model/migrations on load, so a record saved by an older
 * build is upgraded (or rejected with a reason) before it reaches the UI.
 * The v1 single-model key is imported once and then removed.
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

  private read(): StoreShape {
    let store: StoreShape = { activeId: null, models: {}, backups: {} };
    const raw = this.storage.getItem(this.key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoreShape>;
        store = {
          activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
          models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
          backups: parsed.backups && typeof parsed.backups === "object" ? parsed.backups : {},
        };
      } catch {
        store = { activeId: null, models: {}, backups: {} };
      }
    }
    // One-time import of the pre-store single-model key.
    const legacy = this.storage.getItem(this.legacyKey);
    if (legacy) {
      try {
        const obj = JSON.parse(legacy) as { id?: unknown };
        if (obj && typeof obj.id === "string" && !(obj.id in store.models)) {
          store.models[obj.id] = obj;
          if (!store.activeId) store.activeId = obj.id;
          this.write(store);
        }
      } catch {
        // unreadable legacy record: drop it
      }
      this.storage.removeItem(this.legacyKey);
    }
    return store;
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

  async save(model: SystemModel): Promise<void> {
    const validated = SystemModelSchema.parse(model);
    const store = this.read();
    store.models[validated.id] = validated;
    this.write(store);
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
