import type { SystemModel } from "@/types";
import type { ModelRepository } from "./model-repository";

export class MemoryModelRepository implements ModelRepository {
  private model: SystemModel | null = null;
  async load(): Promise<SystemModel | null> {
    return this.model ? structuredClone(this.model) : null;
  }
  async save(model: SystemModel): Promise<void> {
    this.model = structuredClone(model);
  }
  async clear(): Promise<void> {
    this.model = null;
  }
}
