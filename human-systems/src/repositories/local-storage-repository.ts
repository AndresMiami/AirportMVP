import { SystemModelSchema, type SystemModel } from "@/types";
import type { ModelRepository } from "./model-repository";

export const STORAGE_KEY = "human-systems.model.v1";

/** Minimal storage interface so tests can pass a fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class LocalStorageModelRepository implements ModelRepository {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string = STORAGE_KEY,
  ) {}

  async load(): Promise<SystemModel | null> {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      const parsed = SystemModelSchema.safeParse(JSON.parse(raw));
      // A corrupt or outdated record is treated as absent rather than
      // half-loaded; the service then seeds the sample model.
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async save(model: SystemModel): Promise<void> {
    const validated = SystemModelSchema.parse(model);
    this.storage.setItem(this.key, JSON.stringify(validated));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.key);
  }
}
