import type { SystemModel } from "@/types";

/** Persistence boundary. Implementations validate on load. */
export interface ModelRepository {
  load(): Promise<SystemModel | null>;
  save(model: SystemModel): Promise<void>;
  clear(): Promise<void>;
}
