/**
 * Cross-context recurrence: occurrences O = {t : Y(t) = y*}, contrasts
 * C = {t : Y(t) != y*}, and for every other condition Z: common /
 * background / differentiating / mixed / undecided / insufficient.
 *
 *   ABSENCE IS NOT DIFFERENCE   RESOLUTION != OBSERVATION   EXTENT, NOT POINT
 */
import { describe, expect, it } from "vitest";
import { containsForbiddenPhrase, crossContext, type CrossContext, type PatternRef } from "@/discovery";
import { createBlankModel } from "@/model/blank";
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import * as M from "@/services/mutations";
import { VariableSchema, type StoredVariable, type SystemModel, type TemporalRef, type ValueEntry } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

const DOMAIN: DomainDefinition = {
  id: "cross_context_test",
  version: 1,
  name: "Cross-context (test)",
  description: "",
  kinds: [{ id: "unit", label: "Unit" }],
  subjectLabel: "Part",
  variables: [],
  derived: [],
  projections: [],
  signatureDefinition: SignatureDefinitionSchema.parse({ id: "cc_v1", name: "cc", domainId: "cross_context_test", version: 1, dimensions: [{ id: "d", name: "d", explanation: "x", inputs: [{ variableKey: "income_stability", transform: { kind: "ratio", strongAt: 10 }, question: "?" }] }] }),
  constraintTemplates: [],
  eventTypes: ["other"],
};
domainRegistry.register(DOMAIN);

const date = (iso: string): TemporalRef => ({ kind: "date", start: iso, precision: "day", text: iso });
const approxMonth = (start: string, text: string): TemporalRef => ({ kind: "approx", start, precision: "month", text });
const range = (start: string, end: string, text: string): TemporalRef => ({ kind: "range", start, end, precision: "day", text });

let seq = 0;
function entry(value: number | null, valid: TemporalRef, extra: Partial<ValueEntry> = {}): ValueEntry {
  seq += 1;
  return { id: `e${seq}`, value, valid, validBasis: "asserted", recordedAt: "2026-09-01T00:00:00.000Z", sourceType: "self_reported", confidence: 0.7, evidence: [], observationIds: [], note: "", status: "active", ...extra };
}
function variable(id: string, subjectId: string | null, values: ValueEntry[], unit = "u"): StoredVariable {
  return VariableSchema.parse({ id, key: id, subjectId, name: id, category: "structure", changeSpeed: "slow", kind: "input", unit, controllability: 0.5, durability: 0.5, estimatedCostToChange: 0.5, values });
}

// Occurrences of Y = 5: Feb 2025 (two identical entries), Jul 2025, Jan 2026, "around June 2026" (approximate month).
// Contrasts: Apr 2025 = 8, Oct 2025 = 9, Mar 2026 = 8.
const O = ["2025-02-10", "2025-07-10", "2026-01-10"];
const O4 = approxMonth("2026-06-01", "around June 2026");
const C = ["2025-04-15", "2025-10-15", "2026-03-15"];
const INTERVAL = { from: "2025-01-01", to: "2026-12-31" };

function system(): SystemModel {
  let m = createBlankModel({ id: "sys", name: "Sys", systemType: "unit", now: "2024-06-01T00:00:00.000Z", domain: DOMAIN });
  m = M.addMember(m, { id: "p1", label: "Part one", role: "" });
  m = M.addMember(m, { id: "p2", label: "Part two", role: "" });
  const Y = variable("income_stability", "p1", [
    entry(5, date(O[0])),
    entry(5, date(O[0])), // duplicate identical record at the same application time
    entry(8, date(C[0])),
    entry(5, date(O[1])),
    entry(9, date(C[1])),
    entry(5, date(O[2])),
    entry(8, date(C[2])),
    entry(5, O4),
  ]);
  const vars: StoredVariable[] = [
    Y,
    // differs across occurrences; the June record (20 June) lies INSIDE the approximate occurrence, not at its midnight
    variable("work_arrangement", "p1", [entry(1, date(O[0])), entry(2, date(O[1])), entry(3, date(O[2])), entry(4, date("2026-06-20")), entry(1, date(C[0])), entry(2, date(C[1])), entry(3, date(C[2]))]),
    // the same everywhere: background
    variable("autonomy_pref", "p1", [...O, ...C].map((d) => entry(0.8, date(d))).concat([entry(0.8, date("2026-06-15"))])),
    // 1.5 at every occurrence, 3 at every contrast: distinguishes the recorded cases
    variable("buffer", "sys", [...O.map((d) => entry(1.5, date(d))), entry(1.5, date("2026-06-10")), ...C.map((d) => entry(3, date(d)))], "months"),
    // unresolved in 4 of 7 relevant cases
    variable("health_cover", "sys", [entry(1, date(O[0])), entry(1, date(O[1])), entry(null, date(O[2])), entry(1, date(C[0]))]),
    // common at occurrences; contrasts same, different, same
    variable("mixed_z", "p1", [...O.map((d) => entry(2, date(d))), entry(2, date("2026-06-05")), entry(2, date(C[0])), entry(7, date(C[1])), entry(2, date(C[2]))]),
    // one old value before the interval, carried to every occurrence: never "common"
    variable("carried_only", "sys", [entry(9, date("2024-12-01"))]),
    // common at occurrences on recorded-basis dates: participates, caveated
    variable("recorded_basis", "p1", [...O.map((d) => entry(4, date(d), { validBasis: "recorded" })), entry(4, date("2026-06-12"), { validBasis: "recorded" }), ...C.map((d) => entry(4, date(d)))]),
    // common at occurrences; every contrast reading is an explicit unknown or carried: undecided, never differentiating
    variable("absent_contrast", "sys", [...O.map((d) => entry(6, date(d))), entry(6, date("2026-06-08")), entry(null, date(C[0]))]),
    // one stated range covering the whole period: explicit range coverage at every slice
    variable("range_cov", "p1", [entry(3, range("2025-01-01", "2026-12-31", "all of 2025 and 2026"))]),
    // out of scope: another subject, and unassigned
    variable("other_subject", "p2", [...O, ...C].map((d) => entry(1, date(d)))),
    variable("unassigned", null, [...O, ...C].map((d) => entry(1, date(d)))),
  ];
  m = { ...m, variables: [...m.variables, ...vars] };
  m = M.addEvent(m, { kind: "shock", type: "other", title: "Near the July occurrence", occurred: date("2025-07-20"), recordedAt: "2025-07-21T00:00:00.000Z", sourceType: "observed", confidence: 0.8, subjectId: "p1" });
  m = M.addEvent(m, { kind: "change", type: "other", title: "System event near July", occurred: date("2025-07-20"), recordedAt: "2025-07-21T00:00:00.000Z", sourceType: "observed", confidence: 0.8, subjectId: "sys" });
  m = M.addEvent(m, { kind: "change", type: "other", title: "Other subject's event near July", occurred: date("2025-07-20"), recordedAt: "2025-07-21T00:00:00.000Z", sourceType: "observed", confidence: 0.8, subjectId: "p2" });
  m = M.addEvent(m, { kind: "change", type: "other", title: "Unassigned event near July", occurred: date("2025-07-20"), recordedAt: "2025-07-21T00:00:00.000Z", sourceType: "observed", confidence: 0.8 });
  m = M.addEvent(m, { kind: "change", type: "other", title: "Far from everything", occurred: date("2025-12-01"), recordedAt: "2025-12-02T00:00:00.000Z", sourceType: "observed", confidence: 0.8 });
  return m;
}

const PATTERN: PatternRef = {
  variableId: "income_stability",
  subjectId: "p1",
  interval: INTERVAL,
  repeatedValue: 5,
  occurrenceTimes: ["2025-02-10T00:00:00.000Z", "2025-07-10T00:00:00.000Z", "2026-01-10T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
};

function ok(r: ReturnType<typeof crossContext>): CrossContext {
  if (!r.ok) throw new Error(r.message);
  return r;
}
const cond = (r: CrossContext, id: string) => r.conditions.find((c) => c.variableId === id)!;

describe("crossContext", () => {
  const m = system();
  const r = ok(crossContext(m, PATTERN));

  it("finds 4 occurrences and 3 contrasts, keeps duplicate identical records as one occurrence with both entry ids", () => {
    expect(r.occurrences).toHaveLength(4);
    expect(r.contrasts).toHaveLength(3);
    expect(r.contrastNote).toBe("available");
    expect(r.occurrences[0].patternEntryIds).toHaveLength(2);
    expect(r.occurrences.map((s) => s.patternValue)).toEqual([5, 5, 5, 5]);
    expect(r.contrasts.map((s) => s.patternValue)).toEqual([8, 9, 8]);
    expect(r.statements[0]).toBe("income_stability was recorded at 5 u at 4 dates; it was recorded at other values at 3 dates.");
  });

  it("an occurrence keeps its own temporal EXTENT: the approximate June occurrence reads context over the whole month, not at midnight", () => {
    const june = r.occurrences[3];
    expect(june.application).toMatchObject({ kind: "approx", precision: "month", start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z", text: "around June 2026" });
    const wa = june.context.find((c) => c.variableId === "work_arrangement")!;
    expect(wa).toMatchObject({ value: 4, basis: "asserted_coverage" }); // the 20 June record overlaps the extent
    expect(r.caveats.map((c) => c.code)).toContain("extent_not_point");
  });

  it("the worked example: differed / background / distinguishes / not enough evidence, in those words", () => {
    expect(cond(r, "work_arrangement").atOccurrences).toBe("differing");
    expect(cond(r, "work_arrangement").statement).toBe("work_arrangement differed across the 4 occurrences (1 u, 2 u, 3 u, 4 u).");
    const a = cond(r, "autonomy_pref");
    expect(a).toMatchObject({ atOccurrences: "common", commonValue: 0.8, contrastUsable: 3, contrastSame: 3, contrastDifferent: 0 });
    expect(a).toMatchObject({ contrastShows: "same", contrastCoverage: "complete" });
    expect(a.statement).toBe("autonomy_pref was recorded at 0.8 u at all 4 occurrences and at all 3 contrast times; present whether the pattern occurred or not, so it does not by itself distinguish the cases.");
    const b = cond(r, "buffer");
    expect(b).toMatchObject({ atOccurrences: "common", commonValue: 1.5, contrastSame: 0, contrastDifferent: 3 });
    expect(b).toMatchObject({ contrastShows: "different", contrastCoverage: "complete" });
    expect(b.statement).toBe("buffer was recorded at 1.5 months at all 4 occurrences and different at all 3 contrast times; this distinguishes the recorded cases. Recorded together is not caused by.");
    const h = cond(r, "health_cover");
    expect(h).toMatchObject({ atOccurrences: "insufficient", occurrenceUsable: 2, occurrenceTotal: 4 });
    expect(h.statement).toBe("health_cover is unresolved in 4 of 7 relevant cases (2 of 4 occurrences readable; 3 cases recorded as unknown or not recorded, 1 case with only an older value standing); not enough evidence to compare.");
    expect(r.groups).toMatchObject({ differingAtOccurrences: ["work_arrangement"], backgroundComplete: expect.arrayContaining(["autonomy_pref"]), differentiatingComplete: ["buffer"], insufficientAtOccurrences: expect.arrayContaining(["health_cover"]) });
  });

  it("mixed: the same at some usable contrasts and different at others is neither background nor differentiating", () => {
    const z = cond(r, "mixed_z");
    expect(z).toMatchObject({ atOccurrences: "common", contrastSame: 2, contrastDifferent: 1 });
    expect(z).toMatchObject({ contrastShows: "mixed", contrastCoverage: "complete" });
    expect(z.statement).toMatch(/the same at 2 and different at 1 of 3 contrast times, so the recorded cases are only partly distinguished/);
    expect(r.groups.mixedComplete).toEqual(["mixed_z"]);
  });

  it("RESOLUTION != OBSERVATION: a carried-forward value never counts as recorded at an occurrence", () => {
    const c = cond(r, "carried_only");
    expect(c.occurrenceBases).toEqual(["carried_forward_only", "carried_forward_only", "carried_forward_only", "carried_forward_only"]);
    expect(c.occurrenceValues).toEqual([9, 9, 9, 9]); // the value is visible, its basis disqualifies it
    expect(c.atOccurrences).toBe("insufficient");
    expect(r.groups.commonAtOccurrences).not.toContain("carried_only");
    expect(r.groups.insufficientAtOccurrences).toContain("carried_only");
    expect(r.caveats.map((x) => x.code)).toContain("resolution_not_observation");
  });

  it("ABSENCE IS NOT DIFFERENCE: unknown or carried contrast readings never make a condition differentiating", () => {
    const a = cond(r, "absent_contrast");
    expect(a).toMatchObject({ atOccurrences: "common", commonValue: 6, contrastTotal: 3, contrastUsable: 0, contrastDifferent: 0, contrastShows: "none", contrastCoverage: "none" });
    expect(a.statement).toMatch(/no usable contrast reading exists \(3 contrast times, 3 unresolved\), so whether it distinguishes the cases is undecided/);
    // the contrast readings: an explicit unknown, then the resolver carrying 6 forward
    const bases = r.contrasts.map((s) => s.context.find((c) => c.variableId === "absent_contrast")!.basis);
    expect(bases).toEqual(["unknown", "carried_forward_only", "carried_forward_only"]);
    expect(r.caveats.map((x) => x.code)).toContain("absence_not_difference");
  });

  it("recorded-basis coverage participates but is flagged and caveated; a stored range covers every slice explicitly", () => {
    const rb = cond(r, "recorded_basis");
    expect(rb).toMatchObject({ atOccurrences: "common", reliesOnRecordedBasis: true });
    expect(rb.occurrenceBases.every((b) => b === "recorded_basis_coverage")).toBe(true);
    expect(rb.statement).toMatch(/relying partly on dates known only from when the information was recorded/);
    expect(r.caveats.map((x) => x.code)).toContain("recorded_basis");
    const rc = cond(r, "range_cov");
    expect(rc.occurrenceBases.every((b) => b === "explicit_range_coverage")).toBe(true);
    expect(rc).toMatchObject({ atOccurrences: "common", commonValue: 3, reliesOnRecordedBasis: false });
  });

  it("contrast DIRECTION and COVERAGE are independent: 3/3, 2/3, 1/3 and 0/3 usable contrasts are worded differently and never collapse", () => {
    // Build Z = 1 at every occurrence and Z = 2 at some contrasts; the rest of the contrasts have Z recorded as unknown.
    const withZ = (usableAt: string[]) => {
      const entries = [...O.map((d) => entry(1, date(d))), entry(1, date("2026-06-09")), ...C.map((d) => (usableAt.includes(d) ? entry(2, date(d)) : entry(null, date(d))))];
      return { ...m, variables: [...m.variables, variable("cov_z", "sys", entries)] };
    };
    const fullR = ok(crossContext(withZ(C), PATTERN));
    const full = cond(fullR, "cov_z");
    expect(full).toMatchObject({ contrastShows: "different", contrastCoverage: "complete", contrastUsable: 3 });
    expect(fullR.groups.differentiatingComplete).toContain("cov_z");
    expect(full.statement).toMatch(/different at all 3 contrast times; this distinguishes the recorded cases/);
    const twoR = ok(crossContext(withZ(C.slice(0, 2)), PATTERN));
    const two = cond(twoR, "cov_z");
    expect(two).toMatchObject({ contrastShows: "different", contrastCoverage: "partial", contrastUsable: 2, contrastTotal: 3 });
    // partial coverage is NEVER filed as a complete distinction
    expect(twoR.groups.differentiatingComplete).not.toContain("cov_z");
    expect(twoR.groups.contrastPartial).toContain("cov_z");
    expect(twoR.groups.commonAtOccurrences).toContain("cov_z");
    expect(two.statement).toMatch(/different at the 2 readable contrast times; 1 other contrast time is unresolved, so the comparison is incomplete\./);
    expect(two.statement).not.toMatch(/distinguishes the recorded cases/);
    const one = cond(ok(crossContext(withZ(C.slice(0, 1)), PATTERN)), "cov_z");
    expect(one).toMatchObject({ contrastShows: "different", contrastCoverage: "partial", contrastUsable: 1 });
    expect(one.statement).toMatch(/different at the 1 readable contrast time; 2 other contrast times are unresolved, so the comparison is incomplete\./);
    const none = cond(ok(crossContext(withZ([]), PATTERN)), "cov_z");
    expect(none).toMatchObject({ contrastShows: "none", contrastCoverage: "none" });
    expect(none.statement).toMatch(/undecided/);
    // same + partial, and mixed + partial, are worded cautiously too
    const samePartial = { ...m, variables: [...m.variables, variable("same_p", "sys", [...O.map((d) => entry(1, date(d))), entry(1, date("2026-06-09")), entry(1, date(C[0])), entry(1, date(C[1])), entry(null, date(C[2]))])] };
    const spR = ok(crossContext(samePartial, PATTERN));
    const sp = cond(spR, "same_p");
    expect(sp).toMatchObject({ contrastShows: "same", contrastCoverage: "partial" });
    expect(spR.groups.backgroundComplete).not.toContain("same_p");
    expect(spR.groups.contrastPartial).toContain("same_p");
    expect(sp.statement).toMatch(/the same at the 2 readable contrast times; 1 other contrast time is unresolved, so whether it distinguishes the cases remains open\./);
    const mixedPartial = { ...m, variables: [...m.variables, variable("mixed_p", "sys", [...O.map((d) => entry(1, date(d))), entry(1, date("2026-06-09")), entry(1, date(C[0])), entry(2, date(C[1])), entry(null, date(C[2]))])] };
    const mp = cond(ok(crossContext(mixedPartial, PATTERN)), "mixed_p");
    expect(mp).toMatchObject({ contrastShows: "mixed", contrastCoverage: "partial", contrastSame: 1, contrastDifferent: 1 });
    expect(mp.statement).toMatch(/the same at 1 and different at 1 of the 2 readable contrast times; 1 other contrast time is unresolved\./);
    // no threshold, probability or strength label anywhere
    for (const c of [full, two, one, none, sp, mp]) expect(Object.keys(c).some((k) => /score|probab|strength|minimum/i.test(k))).toBe(false);
  });

  it("temporal shape and epistemic basis stay independent: a recorded-basis RANGE is range coverage AND relies on recorded basis", () => {
    const rr = { ...m, variables: [...m.variables, variable("rec_range", "p1", [entry(7, range("2025-01-01", "2026-12-31", "the whole period"), { validBasis: "recorded" })])] };
    const c = cond(ok(crossContext(rr, PATTERN)), "rec_range");
    expect(c.occurrenceBases.every((b) => b === "explicit_range_coverage")).toBe(true);
    expect(c).toMatchObject({ atOccurrences: "common", commonValue: 7, occurrenceUsable: 4, reliesOnRecordedBasis: true });
    expect(c.statement).toMatch(/relying partly on dates known only from when the information was recorded/);
    expect(ok(crossContext(rr, PATTERN)).caveats.map((x) => x.code)).toContain("recorded_basis");
    const reading = ok(crossContext(rr, PATTERN)).occurrences[0].context.find((x) => x.variableId === "rec_range")!;
    expect(reading).toMatchObject({ basis: "explicit_range_coverage", validBasis: "recorded" });
  });

  it("events are scoped like context: the pattern's subject and the system count; another subject's event on the same date and an unassigned event do not", () => {
    const july = r.occurrences[1].eventsNear.map((e) => e.title).sort();
    expect(july).toEqual(["Near the July occurrence", "System event near July"]);
    expect(july).not.toContain("Other subject's event near July");
    expect(july).not.toContain("Unassigned event near July");
    // an explicit context scope applies to events consistently
    const p2Scope = ok(crossContext(m, PATTERN, { contextSubjectIds: ["p2"] }));
    expect(p2Scope.occurrences[1].eventsNear.map((e) => e.title)).toEqual(["Other subject's event near July"]);
    expect(p2Scope.conditions.map((c) => c.variableId)).toEqual(["other_subject"]);
  });

  it("context scope is the pattern's subject plus the system; other subjects and unassigned variables are excluded; events are gathered per occurrence window", () => {
    const ids = r.conditions.map((c) => c.variableId);
    expect(ids).not.toContain("other_subject");
    expect(ids).not.toContain("unassigned");
    expect(ids).not.toContain("income_stability");
    expect(ids).toEqual(expect.arrayContaining(["buffer", "autonomy_pref"]));
    expect(r.occurrences[1].eventsNear.map((e) => e.title).sort()).toEqual(["Near the July occurrence", "System event near July"]);
    expect(r.occurrences[0].eventsNear).toEqual([]);
    expect(r.window).toEqual({ days: 30, convention: "display" });
    const narrow = ok(crossContext(m, PATTERN, { eventWindowDays: 5 }));
    expect(narrow.occurrences[1].eventsNear).toEqual([]);
  });

  it("with no contrast recorded, every common condition is undecided and the caveat says so", () => {
    const noC = { ...m, variables: m.variables.map((v) => (v.id === "income_stability" ? { ...v, values: v.values.filter((e) => e.value === 5) } : v)) };
    const rr = ok(crossContext(noC, PATTERN));
    expect(rr.contrasts).toEqual([]);
    expect(rr.contrastNote).toBe("none_recorded");
    expect(rr.groups.differentiatingComplete).toEqual([]);
    expect(rr.groups.backgroundComplete).toEqual([]);
    expect(rr.groups.contrastPartial).toEqual([]);
    expect(rr.groups.undecided).toEqual(expect.arrayContaining(["autonomy_pref", "buffer", "mixed_z", "recorded_basis", "absent_contrast", "range_cov"]));
    expect(rr.caveats.map((x) => x.code)).toContain("no_contrasts");
    expect(rr.statements[0]).toMatch(/no other known value was recorded in this period/);
  });

  it("refuses data conditions with typed reasons: unassigned subject, unknown or derived variable, mismatched or non-recurring pattern", () => {
    const unassigned = crossContext(m, { ...PATTERN, variableId: "unassigned", subjectId: null });
    expect(unassigned).toMatchObject({ ok: false, reason: "unassigned_subject", message: "Assign this record to a subject before exploring its surrounding context." });
    expect(crossContext(m, { ...PATTERN, variableId: "nope" })).toMatchObject({ ok: false, reason: "unknown_variable" });
    expect(crossContext(m, { ...PATTERN, subjectId: "p2" })).toMatchObject({ ok: false, reason: "pattern_mismatch" });
    expect(crossContext(m, { ...PATTERN, repeatedValue: 8, occurrenceTimes: PATTERN.occurrenceTimes })).toMatchObject({ ok: false, reason: "pattern_mismatch" }); // 8 recurs at 2 times, but not at these
    expect(crossContext(m, { ...PATTERN, repeatedValue: 9 })).toMatchObject({ ok: false, reason: "not_recurring" });
    expect(crossContext(m, { ...PATTERN, occurrenceTimes: PATTERN.occurrenceTimes.slice(0, 3) })).toMatchObject({ ok: false, reason: "pattern_mismatch" });
    const withDerived = { ...m, variables: [...m.variables, VariableSchema.parse({ id: "calc", key: "calc", subjectId: "p1", name: "calc", category: "structure", changeSpeed: "slow", kind: "derived", formulaId: "f", unit: "u", controllability: 0.5, durability: 0.5, estimatedCostToChange: 0.5 })] };
    expect(crossContext(withDerived, { ...PATTERN, variableId: "calc" })).toMatchObject({ ok: false, reason: "derived_variable" });
  });

  it("A. conflicting records for the SAME time are ambiguous; B. distinct dated values inside an approximate-month occurrence varied within the extent", () => {
    const withBoth = {
      ...m,
      variables: [
        ...m.variables,
        // A: two records on the February occurrence date with different values
        variable("amb_z", "sys", [entry(1, date(O[0])), entry(2, date(O[0])), entry(1, date(O[1])), entry(1, date(O[2])), entry(1, date("2026-06-09"))]),
        // B: one value on 5 June and another on 20 June inside "around June 2026"
        variable("varied_z", "sys", [...O.map((d) => entry(1, date(d))), entry(1, date("2026-06-05")), entry(3, date("2026-06-20"))]),
      ],
    };
    const rr = ok(crossContext(withBoth, PATTERN));
    const amb = rr.occurrences[0].context.find((c) => c.variableId === "amb_z")!;
    expect(amb).toMatchObject({ basis: "ambiguous", value: null });
    expect(amb.entryIds).toHaveLength(2);
    const varied = rr.occurrences[3].context.find((c) => c.variableId === "varied_z")!;
    expect(varied).toMatchObject({ basis: "varied_within_extent", value: null, validBasis: null });
    expect(varied.entryIds).toHaveLength(2);
    // neither counts as common nor as differing value evidence; both are unresolved for that occurrence
    for (const id of ["amb_z", "varied_z"]) {
      const c = cond(rr, id);
      expect(c.atOccurrences).toBe("insufficient");
      expect(c.occurrenceUsable).toBe(3);
      expect(rr.groups.commonAtOccurrences).not.toContain(id);
      expect(rr.groups.differingAtOccurrences).not.toContain(id);
      expect(rr.groups.insufficientAtOccurrences).toContain(id);
    }
    expect(cond(rr, "varied_z").statement).toMatch(/1 case that varied within the occurrence period/);
    // the February conflict also carries into the April contrast through the resolver: two ambiguous readings
    expect(cond(rr, "amb_z").statement).toMatch(/2 cases with conflicting records for the same time/); // cases, not source records
    // the two situations are explained differently
    const codes = rr.caveats.map((c) => c.code);
    expect(codes).toContain("varied_within_extent");
    expect(codes).toContain("ambiguous_context");
    expect(rr.caveats.find((c) => c.code === "varied_within_extent")!.text).toMatch(/variation during the period, not conflicting records for the same time/);
    // a single-day occurrence with two different records is a conflict, never variation
    expect(rr.occurrences[0].context.find((c) => c.variableId === "amb_z")!.basis).not.toBe("varied_within_extent");
  });

  it("every statement and caveat is descriptive: no forbidden phrase, no cause, no score, no ranking", () => {
    for (const t of [...r.statements, ...r.caveats.map((c) => c.text)]) {
      expect(containsForbiddenPhrase(t), t).toBeNull();
      expect(t, t).not.toMatch(/\bscore\b|\brank|\bexplains\b|\bbecause of\b/i);
    }
    expect("score" in r).toBe(false);
    expect(Object.keys(r.groups).sort()).toEqual(["backgroundComplete", "commonAtOccurrences", "contrastPartial", "differentiatingComplete", "differingAtOccurrences", "insufficientAtOccurrences", "mixedComplete", "undecided"]);
  });
});
