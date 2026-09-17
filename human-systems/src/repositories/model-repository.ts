import type { SystemModel } from "@/types";

export interface ModelSummary {
  id: string;
  name: string;
  systemType: SystemModel["profile"]["systemType"];
  updatedAt: string;
}

/** Persistence boundary for several systems side by side (a sample and a
 *  real household, say). Implementations validate and migrate on load. */
/** Result of a guarded write: written, or refused because the stored
 *  revision differed from the expectation (nothing written). */
export type GuardedSaveResult = { ok: true } | { ok: false; currentRevision: string | null };

export interface ModelRepository {
  list(): Promise<ModelSummary[]>;
  load(id: string): Promise<SystemModel | null>;
  save(model: SystemModel): Promise<void>;
  /** Compare-and-write: read the stored model, compute its revision with the
   *  caller's function, write ONLY when it equals `expectedRevision` (null =
   *  "no such model yet"). Read, compare and write happen in one synchronous
   *  turn, so within one running app instance no other guarded write can
   *  interleave. Cross-tab protection is future work. */
  saveIfRevision(model: SystemModel, expectedRevision: string | null, revisionOf: (m: SystemModel | null) => string | null): Promise<GuardedSaveResult>;
  /** Whether ANY raw model record exists, readable by this build or not.
   *  Deciding "the store is empty" must never depend on a successful
   *  migration: unreadable != empty. */
  hasStoredModels(): Promise<boolean>;
  /** Raw model records this build could not read (migration or validation
   *  refused), with the reason. They stay stored, byte for byte. */
  unreadable(): Promise<{ id: string; error: string }[]>;
  delete(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string | null): Promise<void>;
  /** Remove everything (used by tests and "start over"). */
  clear(): Promise<void>;
}
