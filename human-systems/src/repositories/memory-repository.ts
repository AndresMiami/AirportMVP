import { SystemModelSchema, type SystemModel } from "@/types";
import type { ModelRepository, ModelSummary } from "./model-repository";

export class MemoryModelRepository implements ModelRepository {
  private models = new Map<string, SystemModel>();
  private activeId: string | null = null;

  async list(): Promise<ModelSummary[]> {
    return [...this.models.values()].map(summarize);
  }
  async load(id: string): Promise<SystemModel | null> {
    const m = this.models.get(id);
    return m ? structuredClone(m) : null;
  }
  async save(model: SystemModel): Promise<void> {
    this.models.set(model.id, structuredClone(SystemModelSchema.parse(model)));
  }
  async delete(id: string): Promise<void> {
    this.models.delete(id);
    if (this.activeId === id) this.activeId = null;
  }
  async getActiveId(): Promise<string | null> {
    return this.activeId;
  }
  async setActiveId(id: string | null): Promise<void> {
    this.activeId = id;
  }
  async clear(): Promise<void> {
    this.models.clear();
    this.activeId = null;
  }
}

export function summarize(m: SystemModel): ModelSummary {
  return { id: m.id, name: m.profile.name, systemType: m.profile.systemType, updatedAt: m.updatedAt };
}
