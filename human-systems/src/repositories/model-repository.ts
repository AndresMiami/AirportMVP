import type { SystemModel } from "@/types";

export interface ModelSummary {
  id: string;
  name: string;
  systemType: SystemModel["profile"]["systemType"];
  updatedAt: string;
}

/** Persistence boundary for several systems side by side (a sample and a
 *  real household, say). Implementations validate and migrate on load. */
export interface ModelRepository {
  list(): Promise<ModelSummary[]>;
  load(id: string): Promise<SystemModel | null>;
  save(model: SystemModel): Promise<void>;
  delete(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string | null): Promise<void>;
  /** Remove everything (used by tests and "start over"). */
  clear(): Promise<void>;
}
