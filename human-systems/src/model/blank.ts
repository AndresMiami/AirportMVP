/**
 * A blank system: profile only, the standard derived-variable records
 * (so ratios appear as soon as inputs exist), no relationships, no
 * interpretations of any kind. Nothing here is specific to any person.
 */
import { SystemModelSchema, type SystemModel, type SystemType } from "@/types";
import { DERIVED_DEFINITIONS, defaultDerivedVariable } from "./derived";

export interface BlankModelOptions {
  id: string;
  name: string;
  systemType: SystemType;
  /** ISO timestamp; passed in so the factory stays pure. */
  now: string;
  location?: string;
  currency?: string;
}

export function createBlankModel(opts: BlankModelOptions): SystemModel {
  return SystemModelSchema.parse({
    schemaVersion: 2,
    id: opts.id,
    profile: {
      name: opts.name,
      systemType: opts.systemType,
      description: "",
      members: [],
      location: opts.location ?? "",
      currency: opts.currency ?? "USD",
    },
    variables: DERIVED_DEFINITIONS.map(defaultDerivedVariable),
    incomeSources: [],
    relationships: [],
    loopAnnotations: {},
    constraints: [],
    actions: [],
    observations: [],
    hypotheses: [],
    currentAttractor: { summary: "", recurringOutcomes: [], sourceType: "self_reported", confidence: 0.5 },
    desiredAttractor: { summary: "", recurringOutcomes: [], sourceType: "self_reported", confidence: 0.5 },
    createdAt: opts.now,
    updatedAt: opts.now,
  });
}
