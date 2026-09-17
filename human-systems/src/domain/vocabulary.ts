/**
 * Human-readable labels and explanations for the enums in types/.
 * Kept out of the UI so tests and future exports can reuse the wording.
 */
import { domainRegistry } from "@/model/domain";
import type { SourceType, VariableCategory } from "@/types";

export interface CategoryMeta {
  label: string;
  short: string;
  description: string;
}

/** Labels for the GENERIC categories. Domain packs supply meta for the
 *  categories they add (see `categoryMeta`). */
export const CATEGORY_META: Record<string, CategoryMeta> = {
  event: {
    label: "Visible event / state",
    short: "Event",
    description: "Fast-changing, visible. What people notice day to day.",
  },
  structure: {
    label: "Structural condition",
    short: "Structure",
    description:
      "Slow-changing condition that stays true across events and keeps producing similar outcomes.",
  },
  constraint: {
    label: "Constraint",
    short: "Constraint",
    description: "Limits which actions are possible at all.",
  },
  dependency: {
    label: "Dependency",
    short: "Dependency",
    description: "Something many outcomes rely on; a source of fragility.",
  },
  buffer: {
    label: "Buffer / redundancy",
    short: "Buffer",
    description: "Reserve or slack that absorbs shocks; a source of resilience.",
  },
  shock: {
    label: "External shock",
    short: "Shock",
    description: "Event from outside the system that the system does not control.",
  },
  asset: {
    label: "Productive asset / capital",
    short: "Asset",
    description: "Something that accumulates or compounds over time.",
  },
};

export const SOURCE_TYPE_META: Record<
  SourceType,
  { label: string; description: string; trust: 1 | 2 | 3 | 4 }
> = {
  measured: {
    label: "Measured",
    description: "Read from a record: bank statement, pay stub, contract.",
    trust: 4,
  },
  calculated: {
    label: "Calculated",
    description: "Recomputed from other variables by a named formula.",
    trust: 3,
  },
  self_reported: {
    label: "Self-reported",
    description: "Stated by someone inside the system about it.",
    trust: 2,
  },
  observed: {
    label: "Observed",
    description: "Reported by someone else who observed it.",
    trust: 2,
  },
  estimated: {
    label: "Estimated",
    description: "A rough estimate by whoever built the model; not stated by the person.",
    trust: 1,
  },
  ai_inferred: {
    label: "AI-inferred",
    description: "Proposed by an AI from text and approved by the person.",
    trust: 1,
  },
  unknown: {
    label: "Unknown",
    description: "Provenance not recorded.",
    trust: 1,
  },
};

/** Meta for any category: generic first, then the domain's additions,
 *  then an honest fallback so an unknown historical word still renders. */
export function categoryMeta(category: VariableCategory, domainCategories?: readonly { id: string; label: string; description: string }[]): CategoryMeta {
  const generic = CATEGORY_META[category];
  if (generic) return generic;
  const candidates = domainCategories ?? domainRegistry.list().flatMap((d) => d.categories ?? []);
  const fromDomain = candidates.find((c) => c.id === category);
  if (fromDomain) return { label: fromDomain.label, short: fromDomain.label.split(/[\s/]/)[0], description: fromDomain.description };
  return { label: category, short: category.slice(0, 8), description: "Not in this domain's vocabulary (kept as recorded)." };
}

/** Wording helpers for confidence, so the UI never invents its own. */
export function confidenceLabel(c: number): string {
  if (c >= 0.85) return "high confidence";
  if (c >= 0.6) return "moderate confidence";
  if (c >= 0.35) return "low confidence";
  return "very low confidence";
}
