/**
 * Typed wrappers over the generic collection tools for the household
 * income-source collection. They live in the SERVICES layer (not the
 * domain pack, which stays a leaf that only supplies configuration):
 * screens and tests keep their vocabulary, the engine sees only a
 * declared collection. Checkpoint 3 decides whether screens keep calling
 * these or drive the generic collection screen from the definition.
 */
import { INCOME_SOURCES, type IncomeSource } from "@/domains/household/income";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";

export type IncomeSourceInput = Omit<IncomeSource, "id" | "evidence" | "notes" | "earner" | "earnerId"> &
  Partial<Pick<IncomeSource, "id" | "evidence" | "notes" | "earner" | "earnerId">>;

export function incomeSourcesOf(model: SystemModel): readonly IncomeSource[] {
  return M.collectionItems<IncomeSource>(model, INCOME_SOURCES);
}

export function addIncomeSource(model: SystemModel, input: IncomeSourceInput): SystemModel {
  return M.addCollectionItem(model, INCOME_SOURCES, { earner: "", earnerId: null, evidence: [], notes: "", ...input });
}

export function updateIncomeSource(model: SystemModel, id: string, patch: Partial<Omit<IncomeSource, "id">>): SystemModel {
  return M.updateCollectionItem(model, INCOME_SOURCES, id, patch);
}

export function removeIncomeSource(model: SystemModel, id: string): SystemModel {
  return M.removeCollectionItem(model, INCOME_SOURCES, id);
}
