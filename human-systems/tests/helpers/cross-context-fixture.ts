/**
 * A neutral recurrence fixture for Explore -> proposal tests (a reduced
 * copy of the cross-context engine fixture): Y = 5 at three dated
 * occurrences and one approximate month; contrasts 8 / 9 / 8; conditions
 * that differ, stay common, distinguish, and stay unresolved; an
 * out-of-scope subject. The engine's classifications are not under test
 * here, only that proposals re-resolve them.
 */
import { createBlankModel } from "@/model/blank";
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import * as M from "@/services/mutations";
import { VariableSchema, type StoredVariable, type SystemModel, type TemporalRef, type ValueEntry } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";
import type { PatternRef } from "@/discovery/cross-context";

export const CC_DOMAIN: DomainDefinition = {
  id: "explore_proposal_test",
  version: 1,
  name: "Explore proposal (test)",
  description: "",
  kinds: [{ id: "unit", label: "Unit" }],
  subjectLabel: "Part",
  variables: [],
  derived: [],
  projections: [],
  signatureDefinition: SignatureDefinitionSchema.parse({ id: "ep_v1", name: "ep", domainId: "explore_proposal_test", version: 1, dimensions: [{ id: "d", name: "d", explanation: "x", inputs: [{ variableKey: "income_stability", transform: { kind: "ratio", strongAt: 10 }, question: "?" }] }] }),
  constraintTemplates: [],
  eventTypes: ["other"],
  explanationCatalogue: {
    prompts: [
      { id: "q_work", locus: "external_to_subject", question: "Could the work available have been mostly short contracts?" },
      { id: "q_pref", locus: "internal_to_subject", question: "Could a preference for autonomy have been stronger at those times?" },
    ],
  },
};
/** The same domain at version 2 with the FIRST question reworded. */
export const CC_DOMAIN_V2: DomainDefinition = { ...CC_DOMAIN, version: 2, explanationCatalogue: { prompts: [{ id: "q_work", locus: "external_to_subject", question: "Was the available work mostly gig work?" }, CC_DOMAIN.explanationCatalogue!.prompts[1]] } };
if (!domainRegistry.get(CC_DOMAIN.id, 1)) domainRegistry.register(CC_DOMAIN);
if (!domainRegistry.get(CC_DOMAIN.id, 2)) domainRegistry.register(CC_DOMAIN_V2);

const date = (iso: string): TemporalRef => ({ kind: "date", start: iso, precision: "day", text: iso });
const approxMonth = (start: string, text: string): TemporalRef => ({ kind: "approx", start, precision: "month", text });
let seq = 0;
export function ccEntry(value: number | null, valid: TemporalRef, extra: Partial<ValueEntry> = {}): ValueEntry {
  seq += 1;
  return { id: `e${seq}`, value, valid, validBasis: "asserted", recordedAt: "2026-09-01T00:00:00.000Z", sourceType: "self_reported", confidence: 0.7, evidence: [], observationIds: [], note: "", status: "active", ...extra };
}
export function ccVariable(id: string, subjectId: string | null, values: ValueEntry[], unit = "u"): StoredVariable {
  return VariableSchema.parse({ id, key: id, subjectId, name: id, category: "structure", changeSpeed: "slow", kind: "input", unit, controllability: 0.5, durability: 0.5, estimatedCostToChange: 0.5, values });
}
export const CC_O = ["2025-02-10", "2025-07-10", "2026-01-10"];
export const CC_C = ["2025-04-15", "2025-10-15", "2026-03-15"];
export const CC_INTERVAL = { from: "2025-01-01", to: "2026-12-31" };
export const CC_DATE = date;

export function ccSystem(): SystemModel {
  let m = createBlankModel({ id: "sys_cc", name: "Sys", systemType: "unit", now: "2024-06-01T00:00:00.000Z", domain: CC_DOMAIN });
  m = M.addMember(m, { id: "p1", label: "Part one", role: "" });
  m = M.addMember(m, { id: "p2", label: "Part two", role: "" });
  const vars: StoredVariable[] = [
    ccVariable("income_stability", "p1", [ccEntry(5, date(CC_O[0])), ccEntry(8, date(CC_C[0])), ccEntry(5, date(CC_O[1])), ccEntry(9, date(CC_C[1])), ccEntry(5, date(CC_O[2])), ccEntry(8, date(CC_C[2])), ccEntry(5, approxMonth("2026-06-01", "around June 2026"))]),
    ccVariable("work_arrangement", "p1", [ccEntry(1, date(CC_O[0])), ccEntry(2, date(CC_O[1])), ccEntry(3, date(CC_O[2])), ccEntry(4, date("2026-06-20")), ccEntry(1, date(CC_C[0])), ccEntry(2, date(CC_C[1])), ccEntry(3, date(CC_C[2]))]),
    ccVariable("autonomy_pref", "p1", [...CC_O, ...CC_C].map((d) => ccEntry(0.8, date(d))).concat([ccEntry(0.8, date("2026-06-15"))])),
    ccVariable("buffer", "sys_cc", [...CC_O.map((d) => ccEntry(1.5, date(d))), ccEntry(1.5, date("2026-06-10")), ...CC_C.map((d) => ccEntry(3, date(d)))], "months"),
    ccVariable("health_cover", "sys_cc", [ccEntry(1, date(CC_O[0])), ccEntry(1, date(CC_O[1])), ccEntry(null, date(CC_O[2])), ccEntry(1, date(CC_C[0]))]),
    ccVariable("other_subject", "p2", [...CC_O, ...CC_C].map((d) => ccEntry(1, date(d)))),
  ];
  m = { ...m, variables: [...m.variables, ...vars] };
  m = M.addObservation(m, { id: "obs_unrelated", statement: "Something about part two", sourceType: "self_reported", confidence: 0.5, subjectId: "p2" });
  return m;
}

export const CC_PATTERN: PatternRef = {
  variableId: "income_stability",
  subjectId: "p1",
  interval: CC_INTERVAL,
  repeatedValue: 5,
  occurrenceTimes: ["2025-02-10T00:00:00.000Z", "2025-07-10T00:00:00.000Z", "2026-01-10T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
};
