/**
 * A neutral test domain for the proposal kernel: two system inputs, one
 * member-scope input, one system ratio and one MEMBER-scope derived
 * (so adding a member materializes a derived shell — the case where a
 * single step changes more than the entity it names). Nothing here is
 * about people, money or households.
 */
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import type { ModelService } from "@/services/model-service";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

export const KERNEL_NOW = "2026-09-16T12:00:00.000Z";

export const NEUTRAL_KERNEL_DOMAIN: DomainDefinition = {
  id: "neutral_kernel_test",
  version: 1,
  name: "Neutral kernel (test)",
  description: "Inputs, a ratio and a per-part derived. Nothing about people.",
  kinds: [{ id: "unit", label: "Unit" }],
  subjectLabel: "Part",
  variables: [
    { key: "input_a", name: "Input A", description: "", unit: "u", category: "structure", changeSpeed: "slow", scope: "system", targetMode: "at_least" },
    { key: "input_b", name: "Input B", description: "", unit: "u", category: "buffer", changeSpeed: "fast", scope: "system", targetMode: "at_most" },
    { key: "part_load", name: "Part load", description: "", unit: "u", category: "event", changeSpeed: "fast", scope: "member", targetMode: "at_most" },
  ],
  derived: [
    {
      key: "ratio",
      name: "Ratio",
      description: "input_a / input_b",
      unit: "ratio",
      category: "structure",
      changeSpeed: "slow",
      targetMode: "at_least",
      scope: "system",
      inputs: [
        { key: "input_a", from: "system" },
        { key: "input_b", from: "system" },
      ],
      derivedInputs: [],
      collectionsRead: [],
      assumptionIds: [],
      compute: (ctx) => {
        const a = ctx.value("input_a");
        const b = ctx.value("input_b");
        return a === null || b === null || b === 0 ? null : a / b;
      },
    },
    {
      key: "part_share",
      name: "Part share",
      description: "part_load / input_b",
      unit: "ratio",
      category: "event",
      changeSpeed: "fast",
      targetMode: "at_most",
      scope: "member",
      inputs: [
        { key: "part_load", from: "subject" },
        { key: "input_b", from: "system" },
      ],
      derivedInputs: [],
      collectionsRead: [],
      assumptionIds: [],
      compute: (ctx) => {
        const l = ctx.value("part_load");
        const b = ctx.value("input_b");
        return l === null || b === null || b === 0 ? null : l / b;
      },
    },
  ],
  projections: [],
  signatureDefinition: SignatureDefinitionSchema.parse({
    id: "neutral_kernel_v1",
    name: "Neutral signature",
    domainId: "neutral_kernel_test",
    version: 1,
    dimensions: [{ id: "a_level", name: "A level", explanation: "Input A relative to 100", inputs: [{ variableKey: "input_a", transform: { kind: "ratio", strongAt: 100 }, question: "How much A?" }] }],
  }),
  constraintTemplates: [],
  eventTypes: ["other"],
};
if (!domainRegistry.get(NEUTRAL_KERNEL_DOMAIN.id, NEUTRAL_KERNEL_DOMAIN.version)) domainRegistry.register(NEUTRAL_KERNEL_DOMAIN);

const edge = { kind: "causal_hypothesis" as const, participatesInDynamics: true, strength: 0.5, lag: { value: 1, unit: "months" as const }, confidence: 0.6, sourceType: "self_reported" as const };

/** Build and STORE the neutral system through the given service. */
export async function seedNeutralSystem(svc: ModelService): Promise<SystemModel> {
  let m = await svc.createBlank({ name: "Neutral system", systemType: "unit", domainId: NEUTRAL_KERNEL_DOMAIN.id, domainVersion: NEUTRAL_KERNEL_DOMAIN.version });
  m = M.addMember(m, { id: "p1", label: "Part one", role: "" });
  m = M.addVariable(m, { id: "input_a", name: "Input A", key: "input_a", subjectId: m.id, category: "structure", changeSpeed: "slow", unit: "u", currentValue: 50, sourceType: "measured", confidence: 0.9, recordedAt: "2026-09-01T00:00:00.000Z" });
  m = M.addVariable(m, { id: "input_b", name: "Input B", key: "input_b", subjectId: m.id, category: "buffer", changeSpeed: "fast", unit: "u", currentValue: 25, sourceType: "estimated", confidence: 0.5, recordedAt: "2026-09-01T00:00:00.000Z" });
  m = M.addVariable(m, { id: "part_load_p1", name: "Part load", key: "part_load", subjectId: "p1", category: "event", changeSpeed: "fast", unit: "u", currentValue: 4, sourceType: "self_reported", confidence: 0.7, recordedAt: "2026-09-01T00:00:00.000Z" });
  m = M.addRelationship(m, { id: "rel_ab", sourceVariableId: "input_a", targetVariableId: "input_b", direction: "positive", ...edge });
  m = M.addObservation(m, { id: "obs_a", statement: "Input A was read twice this month", sourceType: "measured", confidence: 0.8, dateOrPeriod: "2026-09" });
  m = M.addHypothesis(m, { id: "hyp_1", statement: "A drives B", confidence: 0.4, relationshipIds: ["rel_ab"] });
  return svc.save(m);
}
