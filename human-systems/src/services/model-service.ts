/**
 * Application service: loads the model (or seeds the sample), saves edits,
 * and exposes the few mutations the MVP screens need. UI code goes through
 * this; it never touches the repository directly.
 */
import { createSampleHousehold } from "@/data/sample-household";
import type { ModelRepository } from "@/repositories";
import {
  IncomeSourceSchema,
  SystemModelSchema,
  VariableSchema,
  type IncomeSource,
  type SystemModel,
  type Variable,
} from "@/types";

export class ModelService {
  constructor(private readonly repo: ModelRepository) {}

  async loadOrSeed(): Promise<{ model: SystemModel; seeded: boolean }> {
    const existing = await this.repo.load();
    if (existing) return { model: existing, seeded: false };
    const model = createSampleHousehold();
    await this.repo.save(model);
    return { model, seeded: true };
  }

  async save(model: SystemModel): Promise<SystemModel> {
    const next = SystemModelSchema.parse({ ...model, updatedAt: new Date().toISOString() });
    await this.repo.save(next);
    return next;
  }

  async resetToSample(): Promise<SystemModel> {
    await this.repo.clear();
    const model = createSampleHousehold();
    await this.repo.save(model);
    return model;
  }

  /** Replace one variable. Derived variables keep their computed fields
   *  protected: only desired value, notes and judgments may change. */
  updateVariable(model: SystemModel, patch: Partial<Variable> & { id: string }): SystemModel {
    const variables = model.variables.map((v) => {
      if (v.id !== patch.id) return v;
      const merged = { ...v, ...patch };
      if (v.kind === "derived") {
        merged.kind = "derived";
        merged.currentValue = v.currentValue;
        merged.sourceType = "calculated";
        merged.confidence = v.confidence;
        merged.formulaId = v.formulaId;
      }
      return VariableSchema.parse(merged);
    });
    return { ...model, variables };
  }

  updateIncomeSource(model: SystemModel, patch: Partial<IncomeSource> & { id: string }): SystemModel {
    const incomeSources = model.incomeSources.map((s) =>
      s.id === patch.id ? IncomeSourceSchema.parse({ ...s, ...patch }) : s,
    );
    return { ...model, incomeSources };
  }
}
