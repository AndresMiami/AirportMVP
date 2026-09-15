/**
 * Application service: which system is active, loading with migration,
 * seeding the sample when nothing exists, creating blank systems, and
 * saving. All model EDITS are pure functions in ./mutations; the UI
 * composes them and hands the result to `save`.
 */
import { createSampleHousehold } from "@/data/sample-household";
import { registerBuiltInDomains } from "@/domains";
import { createBlankModel } from "@/model/blank";
import { domainRegistry } from "@/model/domain";
import type { ModelRepository, ModelSummary } from "@/repositories";
import { migrateModel, type MigrationOptions } from "@/model/migrations";
import { SystemModelSchema, type IncomeSource, type SystemModel, type SystemType } from "@/types";
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

export type ImportResult =
  | { ok: true; model: SystemModel; migratedFrom: number | null; replaced: boolean }
  | { ok: false; error: string };

export const SAMPLE_MODEL_ID = "sample_household_okafor_reyes";

export interface ServiceOptions {
  /** Injectable clock so tests stay deterministic. */
  now?: () => string;
  /** Injectable id source for new systems. */
  newId?: () => string;
}

export class ModelService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly repo: ModelRepository,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => `sys_${Date.now().toString(36)}`);
    registerBuiltInDomains();
  }

  /** The active model, or the first stored one, or a freshly seeded sample. */
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
    const model = createSampleHousehold();
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

  async createBlank(input: {
    name: string;
    systemType: SystemType;
    location?: string;
    currency?: string;
    domainId?: string;
    domainVersion?: number;
  }): Promise<SystemModel> {
    const { domainId = "household", domainVersion, ...rest } = input;
    const domain = domainRegistry.require(domainId, domainVersion);
    const model = createBlankModel({ id: this.newId(), now: this.now(), domain, ...rest });
    await this.repo.save(model);
    await this.repo.setActiveId(model.id);
    return model;
  }

  /** (Re)creates the fictional sample under its fixed id and activates it. */
  async resetSample(): Promise<SystemModel> {
    const model = createSampleHousehold();
    await this.repo.save(model);
    await this.repo.setActiveId(model.id);
    return model;
  }

  async deleteModel(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async save(model: SystemModel): Promise<SystemModel> {
    const next = SystemModelSchema.parse({ ...model, updatedAt: this.now() });
    await this.repo.save(next);
    return next;
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
    const migrationOptions: MigrationOptions = options.migration ?? this.migrationOptionsFor(rec.model);
    const result = migrateModel(rec.model, migrationOptions);
    if (!result.ok) return { ok: false, error: result.error };
    const existing = await this.repo.load(result.model.id);
    if (existing && !options.replace) {
      return { ok: false, error: `A system with id "${result.model.id}" already exists; import with replace to overwrite it.` };
    }
    await this.repo.save(result.model);
    return { ok: true, model: result.model, migratedFrom: result.migratedFrom, replaced: existing !== null };
  }

  private migrationOptionsFor(raw: unknown): MigrationOptions {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const domainId = typeof rec.domainDefinitionId === "string" ? rec.domainDefinitionId : "household";
    const version = typeof rec.domainDefinitionVersion === "number" ? rec.domainDefinitionVersion : undefined;
    const domain = domainRegistry.get(domainId, version);
    return {
      migratedAt: this.now(),
      ...(domain ? { systemScopeKeys: new Set(domain.variables.filter((v) => v.scope === "system").map((v) => v.key)) } : {}),
    };
  }

  /** Convenience wrappers kept for the existing screens. */
  updateVariable(model: SystemModel, patch: M.VariablePatch & { id: string }): SystemModel {
    const { id, ...rest } = patch;
    return M.updateVariable(model, id, rest);
  }

  updateIncomeSource(model: SystemModel, patch: Partial<IncomeSource> & { id: string }): SystemModel {
    const { id, ...rest } = patch;
    return M.updateIncomeSource(model, id, rest);
  }
}
