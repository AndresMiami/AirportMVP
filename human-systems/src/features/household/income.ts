/**
 * HOUSEHOLD FEATURE: typed wrappers over the generic collection tools for
 * the income-source collection. A feature module sits ABOVE the generic
 * services and the domain pack (feature -> services, feature -> pack) and
 * is imported only by household application code (the /income route and
 * tests). Nothing generic imports it; the domain pack stays a leaf.
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
