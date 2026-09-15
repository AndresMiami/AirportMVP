/**
 * A blank system under a domain definition: profile only, the domain's
 * derived-variable records (so ratios appear as soon as inputs exist), no
 * relationships, no interpretations of any kind.
 */
import { MODEL_SCHEMA_VERSION } from "@/types";
import { SystemModelSchema, type SystemModel, type SystemType } from "@/types";
import { defaultDerivedVariable } from "./derived";
import type { DomainDefinition } from "./domain";

export interface BlankModelOptions {
  id: string;
  name: string;
  systemType: SystemType;
  /** ISO timestamp; passed in so the factory stays pure. */
  now: string;
  domain: DomainDefinition;
  location?: string;
  currency?: string;
}

export function createBlankModel(opts: BlankModelOptions): SystemModel {
  return SystemModelSchema.parse({
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: opts.id,
    domainDefinitionId: opts.domain.id,
    domainDefinitionVersion: opts.domain.version,
    profile: {
      name: opts.name,
      systemType: opts.systemType,
      description: "",
      members: [],
      location: opts.location ?? "",
      currency: opts.currency ?? "USD",
    },
    variables: opts.domain.derived.filter((d) => d.scope === "system").map((d) => defaultDerivedVariable(d, opts.id, opts.id)),
    incomeSources: [],
    relationships: [],
    events: [],
    loopAnnotations: {},
    constraints: [],
    actions: [],
    observations: [],
    hypotheses: [],
    signatures: [],
    currentAttractor: { summary: "", recurringOutcomes: [], sourceType: "self_reported", confidence: 0.5 },
    desiredAttractor: { summary: "", recurringOutcomes: [], sourceType: "self_reported", confidence: 0.5 },
    createdAt: opts.now,
    updatedAt: opts.now,
  });
}
