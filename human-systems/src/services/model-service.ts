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
import { SystemModelSchema, type IncomeSource, type SystemModel, type SystemType, type Variable } from "@/types";
import * as M from "./mutations";

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

  /** Convenience wrappers kept for the existing screens. */
  updateVariable(model: SystemModel, patch: Partial<Variable> & { id: string }): SystemModel {
    const { id, ...rest } = patch;
    return M.updateVariable(model, id, rest);
  }

  updateIncomeSource(model: SystemModel, patch: Partial<IncomeSource> & { id: string }): SystemModel {
    const { id, ...rest } = patch;
    return M.updateIncomeSource(model, id, rest);
  }
}
