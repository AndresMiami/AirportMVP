/**
 * Generic application service: which system is active, loading with
 * migration, seeding when nothing exists, creating blank systems, and
 * saving. All model EDITS are pure functions in ./mutations; the UI
 * composes them and hands the result to `save`.
 *
 * The service knows NO concrete domain and NO sample: which domains are
 * registered, which seed fills an empty store and which domain the UI
 * pre-selects are APPLICATION configuration (src/bootstrap), passed in as
 * options. `createBlank` requires an explicit domain id.
 */
import { createBlankModel } from "@/model/blank";
import { domainRegistry } from "@/model/domain";
import type { ModelRepository, ModelSummary } from "@/repositories";
import { migrateModel, type MigrationOptions, migrationOptionsFor } from "@/model/migrations";
import { SystemModelSchema, type SystemModel, type SystemType } from "@/types";
import * as M from "./mutations";

/** The portable file: one system with its complete history. */
export const EXPORT_FORMAT = "human-systems-model";
export const EXPORT_FORMAT_VERSION = 1;

export interface ModelExport {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  schemaVersion: number;
  model: SystemModel;
}

/** A guarded save was refused because the stored revision differed. Nothing was written. */
export class RevisionConflictError extends Error {
  constructor(
    readonly expected: string | null,
    readonly current: string | null,
  ) {
    super("The stored model changed since it was reviewed; nothing was written.");
    this.name = "RevisionConflictError";
  }
}

export type ImportResult =
  | { ok: true; model: SystemModel; migratedFrom: number | null; replaced: boolean }
  | { ok: false; error: string };

/** A seed the application supplies for an empty store: a fixed id (so it
 *  can be recognised and reset) and a factory. The service never knows
 *  what the seed describes. */
export interface SeedConfig {
  id: string;
  /** Short human label for notices ("fictional sample household"). */
  label: string;
  create: () => SystemModel;
}

export interface ServiceOptions {
  /** Injectable clock so tests stay deterministic. */
  now?: () => string;
  /** Injectable id source for new systems. */
  newId?: () => string;
  /** What fills an empty store. Without it, an empty store is an error the
   *  caller must handle (nothing is invented). */
  seed?: SeedConfig;
}

export class ModelService {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly seed: SeedConfig | null;

  constructor(
    private readonly repo: ModelRepository,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => `sys_${Date.now().toString(36)}`);
    this.seed = options.seed ?? null;
  }

  /** The configured seed's id, or null when the application supplies none. */
  get seedId(): string | null {
    return this.seed?.id ?? null;
  }

  get seedLabel(): string | null {
    return this.seed?.label ?? null;
  }

  /** The active model, or the first stored one, or a freshly created seed.
   *  Throws when the store is empty and no seed is configured. */
  async loadActiveOrSeed(): Promise<{ model: SystemModel; seeded: boolean }> {
    const activeId = await this.repo.getActiveId();
    if (activeId) {
      const m = await this.repo.load(activeId);
      if (m) return { model: m, seeded: false };
    }
    const all = await this.repo.list();
    if (all.length > 0) {
      const m = await this.repo.load(all[0].id);
      if (m) {
        await this.repo.setActiveId(m.id);
        return { model: m, seeded: false };
      }
    }
    // Seeding is allowed ONLY when nothing at all is stored. Stored records
    // this build cannot read are not "nothing": refuse, name them, write nothing.
    if (await this.repo.hasStoredModels()) {
      const bad = await this.repo.unreadable();
      const detail = bad.map((b) => `${b.id}: ${b.error}`).join("; ");
      throw new Error(`Stored data could not be read by this build, so no sample was created and nothing was changed. ${bad.length} stored system${bad.length === 1 ? "" : "s"} could not be read${detail ? ` (${detail})` : ""}. The data is kept exactly as it is.`);
    }
    if (!this.seed) throw new Error("Nothing is stored and no seed is configured for this application.");
    const model = this.seed.create();
    await this.repo.save(model);
    await this.repo.setActiveId(model.id);
    return { model, seeded: true };
  }

  listModels(): Promise<ModelSummary[]> {
    return this.repo.list();
  }

  async switchActive(id: string): Promise<SystemModel> {
    const m = await this.repo.load(id);
    if (!m) throw new Error(`No stored system with id ${id}`);
    await this.repo.setActiveId(id);
    return m;
  }

  /** A blank system under an EXPLICIT domain. The kind (`systemType`) is a
   *  human label and never implies the domain. */
  async createBlank(input: {
    name: string;
    systemType: SystemType;
    domainId: string;
    domainVersion?: number;
    location?: string;
    currency?: string;
  }): Promise<SystemModel> {
    const { domainId, domainVersion, ...rest } = input;
    if (!domainId) throw new Error("A new system needs a domain id.");
    const domain = domainRegistry.require(domainId, domainVersion);
    const model = createBlankModel({ id: this.newId(), now: this.now(), domain, ...rest });
    await this.repo.save(model);
    await this.repo.setActiveId(model.id);
    return model;
  }

  /** (Re)creates the configured seed under its fixed id and activates it. */
  async resetSeed(): Promise<SystemModel> {
    if (!this.seed) throw new Error("No seed is configured for this application.");
    const model = this.seed.create();
    await this.repo.save(model);
    await this.repo.setActiveId(model.id);
    return model;
  }

  async deleteModel(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async save(model: SystemModel): Promise<SystemModel> {
    const next = this.finalize(model);
    await this.repo.save(next);
    return next;
  }

  /** The persistence contract shared by save and saveIfRevision: stamp the
   *  commit clock, validate the schema, validate declared collections. */
  private finalize(model: SystemModel): SystemModel {
    const next = SystemModelSchema.parse({ ...model, updatedAt: this.now() });
    const problem = M.collectionProblems(next);
    if (problem) throw new Error(problem);
    return next;
  }

  /** Guarded write for the proposal kernel: same validation as save, then
   *  the repository's compare-and-write. `updatedAt` is commit metadata and
   *  takes no part in the revision. Throws RevisionConflictError (nothing
   *  written) when the stored revision differs. */
  async saveIfRevision(candidate: SystemModel, expectedRevision: string | null, revisionOf: (m: SystemModel | null) => string | null): Promise<SystemModel> {
    const next = this.finalize(candidate);
    const result = await this.repo.saveIfRevision(next, expectedRevision, revisionOf);
    if (!result.ok) throw new RevisionConflictError(expectedRevision, result.currentRevision);
    return next;
  }

  /** The stored model, or null. */
  load(id: string): Promise<SystemModel | null> {
    return this.repo.load(id);
  }

  /** Serialize one stored system, history and all, as a portable JSON string. */
  async exportModel(id: string): Promise<string> {
    const model = await this.repo.load(id);
    if (!model) throw new Error(`No stored system with id ${id}`);
    const file: ModelExport = { format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, exportedAt: this.now(), schemaVersion: model.schemaVersion, model };
    return JSON.stringify(file, null, 2);
  }

  /** Parse and VALIDATE an exported file, migrating older supported schema
   *  versions, before anything is stored. A corrupt file stores nothing.
   *  An existing system with the same id is replaced only with `replace`. */
  async importModel(text: string, options: { replace?: boolean; migration?: MigrationOptions } = {}): Promise<ImportResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "The file is not valid JSON." };
    }
    const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    if (!rec || rec.format !== EXPORT_FORMAT || !rec.model || typeof rec.model !== "object") {
      return { ok: false, error: `Not a ${EXPORT_FORMAT} file.` };
    }
    const migrationOptions: MigrationOptions = options.migration ?? migrationOptionsFor(rec.model, { migratedAt: this.now() });
    const result = migrateModel(rec.model, migrationOptions);
    if (!result.ok) return { ok: false, error: result.error };
    const existing = await this.repo.load(result.model.id);
    if (existing && !options.replace) {
      return { ok: false, error: `A system with id "${result.model.id}" already exists; import with replace to overwrite it.` };
    }
    await this.repo.save(result.model);
    return { ok: true, model: result.model, migratedFrom: result.migratedFrom, replaced: existing !== null };
  }

  /** Convenience wrappers kept for the existing screens. */
  updateVariable(model: SystemModel, patch: M.VariablePatch & { id: string }): SystemModel {
    const { id, ...rest } = patch;
    return M.updateVariable(model, id, rest);
  }

}
