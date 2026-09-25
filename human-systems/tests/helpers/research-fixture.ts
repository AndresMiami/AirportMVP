/** A thesis over the neutral cross-context system, and a source snapshot for it. */
import type { SourceSnapshot } from "@/agents/source";
import * as M from "@/services/mutations";
import type { SystemModel } from "@/types";
import { ccSystem } from "./cross-context-fixture";

export const THESIS_ID = "hyp_thesis";

/** A hypothesis that WATCHES two variables: a kill criterion on the system-level buffer, a prediction on p1's income stability. */
export function researchSystem(): SystemModel {
  let m = ccSystem();
  m = M.addHypothesis(m, {
    id: THESIS_ID,
    statement: "Reserves under two months keep the repetition alive",
    subjectId: "p1",
    predictions: [{ id: "pred_income", statement: "Income stability stays at 5 while the buffer is thin", variableId: "income_stability" }, { statement: "A prediction without a variable" }],
  });
  m = M.addKillCriterion(m, THESIS_ID, { id: "kill_buffer", statement: "Buffer above 3 months and the value still repeats", variableId: "buffer", comparator: "gt", threshold: 3 });
  return m;
}

export function snapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: "bank-export",
    name: "Bank export",
    url: "https://example.com/export",
    version: "2026-07-31",
    retrievedAt: "2026-08-01T09:00:00.000Z",
    items: [
      { key: "buf-2026-07", variableKey: "buffer", period: { text: "31 July 2026", start: "2026-07-31" }, value: 2, sourceType: "measured", quote: "Closing balance covers 2.0 months of essentials", locator: "row 12" },
      { key: "inc-2026-07", variableKey: "income_stability", subjectId: "p1", period: { text: "July 2026", start: "2026-07-01", end: "2026-07-31" }, value: 5, sourceType: "self_reported", quote: "Stability rated 5 for July" },
      { key: "unrelated", variableKey: "not_a_variable", period: { text: "July 2026" }, value: 1, sourceType: "observed", quote: "Something else" },
    ],
    ...overrides,
  };
}
