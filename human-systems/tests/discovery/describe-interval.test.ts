/**
 * describeInterval: the whole-system question for one interval, on three
 * very different systems — a synthetic generic system with every evidence
 * form, a neutral test domain, and the household sample with enriched
 * histories. Buckets are derived from non-exclusive facts; context is
 * evidence, never a score; derived variables are excluded unless asked
 * for and then caveated; snapshots are secondary.
 */
import { describe, expect, it } from "vitest";
import { createSampleHousehold } from "@/data/sample-household";
import { DERIVED_IDS, INPUT_IDS } from "@/domains/household/keys";
import { DERIVED_RECOMPUTATION_CAVEAT, describeInterval } from "@/discovery";
import { createBlankModel } from "@/model/blank";
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import { evaluateSystem } from "@/model/evaluate";
import * as M from "@/services/mutations";
import { computeSignature } from "@/signatures/compute";
import type { SystemModel, TemporalRef } from "@/types";
import { SignatureDefinitionSchema } from "@/types/signature";

const NOW = "2026-12-31T12:00:00.000Z";
const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const date = (iso: string, text = iso): TemporalRef => ({ kind: "date", start: iso, precision: "day", text });
const A23 = { assumptionId: "A23" as const, tolerance: 0.1 };

/** A neutral domain: system inputs a..g and one subject input, one ratio. */
const SYNTH: DomainDefinition = {
  id: "synthetic_test",
  version: 1,
  name: "Synthetic (test)",
  description: "Every evidence form once.",
  kinds: [{ id: "unit", label: "Unit" }],
  subjectLabel: "Part",
  variables: [
    { key: "changing_a", name: "Changing A", description: "", unit: "u", category: "structure", changeSpeed: "fast", scope: "system", targetMode: "exact" },
    { key: "changing_b", name: "Changing B", description: "", unit: "u", category: "structure", changeSpeed: "fast", scope: "system", targetMode: "exact", referenceRange: { min: 0, max: 100 } },
    { key: "repeated_c", name: "Repeated C", description: "", unit: "u", category: "buffer", changeSpeed: "slow", scope: "system", targetMode: "exact" },
    { key: "stale_d", name: "Stale D", description: "", unit: "u", category: "asset", changeSpeed: "slow", scope: "system", targetMode: "exact" },
    { key: "unknown_e", name: "Unknown E", description: "", unit: "u", category: "event", changeSpeed: "fast", scope: "system", targetMode: "exact" },
    { key: "ambiguous_f", name: "Ambiguous F", description: "", unit: "u", category: "event", changeSpeed: "fast", scope: "system", targetMode: "exact" },
    { key: "undated_g", name: "Undated G", description: "", unit: "u", category: "event", changeSpeed: "fast", scope: "system", targetMode: "exact" },
    { key: "part_load", name: "Part load", description: "", unit: "u", category: "event", changeSpeed: "fast", scope: "member", targetMode: "exact" },
  ],
  derived: [
    {
      key: "ratio",
      name: "Ratio",
      description: "a / b",
      unit: "ratio",
      category: "structure",
      changeSpeed: "slow",
      targetMode: "exact",
      scope: "system",
      inputs: [
        { key: "changing_a", from: "system" },
        { key: "changing_b", from: "system" },
      ],
      derivedInputs: [],
      collectionsRead: [],
      assumptionIds: [],
      compute: (ctx) => {
        const a = ctx.value("changing_a");
        const b = ctx.value("changing_b");
        return a === null || b === null || b === 0 ? null : a / b;
      },
    },
  ],
  projections: [],
  signatureDefinition: SignatureDefinitionSchema.parse({
    id: "synth_v1",
    name: "Synthetic signature",
    domainId: "synthetic_test",
    version: 1,
    dimensions: [{ id: "a_level", name: "A level", explanation: "Input A relative to 100", inputs: [{ variableKey: "changing_a", transform: { kind: "ratio", strongAt: 100 }, question: "?" }] }],
  }),
  constraintTemplates: [],
  eventTypes: ["shift", "other"],
};
domainRegistry.register(SYNTH);

const input = (id: string, key: string, subjectId: string, value: number | null, valid: string) =>
  ({ id, key, subjectId, name: key, category: "structure" as const, changeSpeed: "fast" as const, unit: "u", currentValue: value, sourceType: "self_reported" as const, confidence: 0.7, valid: date(valid) });

function synthetic(): SystemModel {
  let m = createBlankModel({ id: "synth", name: "Synthetic", systemType: "unit", now: "2025-01-01T00:00:00.000Z", domain: SYNTH });
  m = M.addMember(m, { id: "p1", label: "Part one", role: "" });
  // several changing variables
  m = M.addVariable(m, { ...input("changing_a", "changing_a", "synth", 10, "2026-01-05") });
  m = M.recordValue(m, "changing_a", { value: 20, sourceType: "self_reported", confidence: 0.7, valid: date("2026-05-05") });
  m = M.recordValue(m, "changing_a", { value: 30, sourceType: "self_reported", confidence: 0.7, valid: date("2026-09-05") });
  m = M.addVariable(m, { ...input("changing_b", "changing_b", "synth", 50, "2026-01-06"), referenceRange: { min: 0, max: 100 } });
  m = M.recordValue(m, "changing_b", { value: 53, sourceType: "measured", confidence: 0.9, valid: date("2026-08-06") }); // low variation under A23 (3%)
  // one recorded repeatedly at the same value
  m = M.addVariable(m, { ...input("repeated_c", "repeated_c", "synth", 5, "2026-01-07") });
  m = M.recordValue(m, "repeated_c", { value: 5, sourceType: "self_reported", confidence: 0.7, valid: date("2026-06-07") });
  m = M.recordValue(m, "repeated_c", { value: 5, sourceType: "observed", confidence: 0.8, valid: date("2026-11-07") });
  // one that both changed and repeated: 3000 -> 5000 -> 5000
  m = M.addVariable(m, { ...input("both_h", "both_h", "synth", 3000, "2026-01-08") });
  m = M.recordValue(m, "both_h", { value: 5000, sourceType: "measured", confidence: 0.9, valid: date("2026-04-08") });
  m = M.recordValue(m, "both_h", { value: 5000, sourceType: "measured", confidence: 0.9, valid: date("2026-08-08") });
  // one single old value carried forward
  m = M.addVariable(m, { ...input("stale_d", "stale_d", "synth", 7, "2025-03-01") });
  // one explicit unknown
  m = M.addVariable(m, { ...input("unknown_e", "unknown_e", "synth", null, "2026-02-01") });
  m = M.recordValue(m, "unknown_e", { value: null, sourceType: "unknown", confidence: 0, valid: date("2026-02-01") });
  // one ambiguous pair (same start, different values)
  m = M.addVariable(m, { ...input("ambiguous_f", "ambiguous_f", "synth", 1, "2026-04-01") });
  m = M.recordValue(m, "ambiguous_f", { value: 2, sourceType: "self_reported", confidence: 0.5, valid: date("2026-04-01") });
  // one unorderable TemporalRef
  m = M.addVariable(m, { ...input("undated_g", "undated_g", "synth", 9, "2026-01-01") });
  m = { ...m, variables: m.variables.map((v) => (v.id === "undated_g" ? { ...v, values: v.values.map((e) => ({ ...e, valid: { kind: "unknown" as const, precision: "unspecified" as const, text: "at some point" } })) } : v)) };
  // a subject-scoped input with one value
  m = M.addVariable(m, { ...input("part_load@p1", "part_load", "p1", 4, "2026-03-01") });
  // events: two dated inside the year, one before, one undated
  m = M.addEvent(m, { kind: "change", type: "shift", title: "Shift in March", occurred: date("2026-03-15"), recordedAt: "2026-03-16T00:00:00.000Z", sourceType: "self_reported", confidence: 0.8, subjectId: "synth" });
  m = M.addEvent(m, { kind: "change", type: "other", title: "Unattributed change", occurred: date("2026-05-15"), recordedAt: "2026-05-16T00:00:00.000Z", sourceType: "self_reported", confidence: 0.8 });
  m = M.addEvent(m, { kind: "shock", type: "other", title: "Shock in July", occurred: date("2026-07-15"), recordedAt: "2026-07-16T00:00:00.000Z", sourceType: "observed", confidence: 0.8, subjectId: "p1" });
  m = M.addEvent(m, { kind: "change", type: "other", title: "Old change", occurred: date("2025-02-01"), recordedAt: "2025-02-02T00:00:00.000Z", sourceType: "self_reported", confidence: 0.8 });
  m = M.addEvent(m, { kind: "decision", type: "other", title: "Undated decision", occurred: { kind: "unknown", precision: "unspecified", text: "no idea when" }, recordedAt: "2026-06-01T00:00:00.000Z", sourceType: "self_reported", confidence: 0.5 });
  return m;
}

const ids = (xs: { description: { variableId: string } }[]) => xs.map((x) => x.description.variableId).sort();

describe("describeInterval on the synthetic system", () => {
  const m = synthetic();
  const d = describeInterval(m, { ...YEAR, lowVariation: A23, now: NOW });

  it("factual groups are non-exclusive: 3000 -> 5000 -> 5000 is both changed and repeated; the small A23 move is both changed and low variation", () => {
    expect(ids(d.buckets.changed)).toEqual(["both_h", "changing_a", "changing_b"]);
    expect(ids(d.buckets.repeated)).toEqual(["both_h", "repeated_c"]);
    expect(ids(d.buckets.lowVariation)).toEqual(["changing_b"]);
    expect(ids(d.buckets.explicitClaims)).toEqual([]);
    expect(ids(d.buckets.lastKnownOnly)).toEqual(["stale_d"]);
    expect(ids(d.buckets.unresolved).sort()).toEqual(["ambiguous_f", "undated_g", "unknown_e"]);
    expect(ids(d.buckets.insufficient)).toEqual(["part_load@p1"]);
    // every variable appears somewhere; a value that changed and repeated says both in one sentence
    const all = new Set(Object.values(d.buckets).flatMap(ids));
    for (const v of d.variables) expect(all.has(v.description.variableId), v.description.variableId).toBe(true);
    const both = d.variables.find((v) => v.description.variableId === "both_h")!;
    expect(both.description.summaryClass).toBe("changed");
    expect(both.description.facts.exactRepetition).toBe(true);
    expect(both.sentences.headline).toMatch(/3 recorded values, 3000 u → 5000 u, Jan 2026 → Aug 2026; the recorded values differ, and 5000 u was recorded on 2 dates\./);
  });

  it("derived variables are absent by default and never candidates", () => {
    expect(d.variables.some((v) => v.description.variableId === "ratio")).toBe(false);
    expect(d.recomputed).toEqual([]);
    expect(d.caveats.map((c) => c.code)).not.toContain("derived_today_structure");
  });

  it("context names what else changed and how many events fell inside, as evidence not a score", () => {
    const c = d.context.find((x) => x.variableId === "repeated_c")!;
    // the FACTUAL changed set: includes the low-variation move and the changed-and-repeated variable
    expect([...c.variablesChanged].sort()).toEqual(["both_h", "changing_a", "changing_b"]);
    expect(c.eventsInInterval).toBe(3);
    expect(d.context.map((x) => x.variableId).sort()).toEqual(["both_h", "changing_b", "repeated_c"]);
    // a candidate that also changed never lists itself
    expect(d.context.find((x) => x.variableId === "both_h")!.variablesChanged).toEqual(["changing_a", "changing_b"]);
    // one context per candidate even when several facts qualify it
    expect(new Set(d.context.map((x) => x.variableId)).size).toBe(d.context.length);
    expect("score" in c).toBe(false);
    expect(d.caveats.find((x) => x.code === "context_not_cause")!.text).toMatch(/not a cause or a score/);
  });

  it("events: dated ones inside the interval are listed in order, undated ones kept aside, earlier ones counted", () => {
    expect(d.events.inInterval.map((e) => e.title)).toEqual(["Shift in March", "Unattributed change", "Shock in July"]);
    expect(d.events.inInterval[0]).toMatchObject({ occurredStart: "2026-03-15T00:00:00.000Z", occurredEnd: "2026-03-15T23:59:59.999Z", orderable: true });
    expect(d.events.unorderable.map((e) => e.title)).toEqual(["Undated decision"]);
    expect(d.events.unorderable[0]).toMatchObject({ orderable: false, occurredStart: null, occurredText: "no idea when" });
    expect(d.events.outsideInterval).toBe(1);
    expect(d.caveats.find((x) => x.code === "events_unorderable")!.text).toMatch(/1 event has no orderable time/);
  });

  it("a subject filter narrows variables and events to that subject", () => {
    const p1 = describeInterval(m, { ...YEAR, subjectId: "p1" });
    expect(p1.variables.map((v) => v.description.variableId)).toEqual(["part_load@p1"]);
    expect(p1.events.inInterval.map((e) => e.title)).toEqual(["Shock in July"]);
    expect(p1.subjectId).toBe("p1");
    const sys = describeInterval(m, { ...YEAR, subjectId: "synth" });
    expect(sys.variables.some((v) => v.description.variableId === "part_load@p1")).toBe(false);
    // an unattributed event (subject null) is never counted as the system's: null is not the system
    expect(sys.events.inInterval.map((e) => e.title)).toEqual(["Shift in March"]);
  });

  it("without the A23 convention the small move is simply 'changed' with its raw range; the output exists either way", () => {
    const plain = describeInterval(m, YEAR);
    expect(ids(plain.buckets.changed)).toEqual(["both_h", "changing_a", "changing_b"]);
    expect(plain.buckets.lowVariation).toEqual([]);
    const b = plain.variables.find((v) => v.description.variableId === "changing_b")!;
    expect(b.description.variation).toMatchObject({ min: 50, max: 53, rawRange: 3, normalizedRange: null, convention: null });
    expect(b.sentences.headline).toMatch(/50 u → 53 u/);
  });

  it("derived recomputation on request goes to its own section with the today's-structure caveat", () => {
    const withDerived = describeInterval(m, { ...YEAR, includeDerived: true, now: NOW });
    expect(withDerived.recomputed.map((r) => r.variableId)).toEqual(["ratio"]);
    const r = withDerived.recomputed[0];
    expect(r.atStart).toBeNull(); // Jan 1: no value for a or b yet
    expect(r.atEnd).toBeCloseTo(30 / 53, 9);
    expect(r.differs).toBeNull();
    expect(r.caveat).toBe(DERIVED_RECOMPUTATION_CAVEAT);
    expect(withDerived.caveats.map((c) => c.code)).toContain("derived_today_structure");
    // and it is never a candidate
    expect(withDerived.context.some((c) => c.variableId === "ratio")).toBe(false);
    const later = describeInterval(m, { from: "2026-06-01", to: "2026-12-31", includeDerived: true, now: NOW });
    expect(later.recomputed[0]).toMatchObject({ atStart: 20 / 50, atEnd: 30 / 53, differs: true });
  });

  it("interval boundaries: a narrower interval changes what overlaps, and the disclaimer is always present", () => {
    const h1 = describeInterval(m, { from: "2026-01-01", to: "2026-06-30" });
    // repeated_c has two dated records in H1 (Jan, Jun): still repeated; changing_a has Jan and May: changed
    expect(ids(h1.buckets.repeated)).toEqual(["repeated_c"]);
    // both_h has Jan 3000 and Apr 5000 in H1: changed, and 5000 only once so not repeated there
    expect(ids(h1.buckets.changed)).toEqual(["both_h", "changing_a"]);
    // changing_b has only January inside H1 -> insufficient there
    expect(ids(h1.buckets.insufficient)).toEqual(expect.arrayContaining(["changing_b"]));
    expect(h1.disclaimer).toBe("Repeated or stable observations do not establish cause.");
    expect(d.interval).toMatchObject({ from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T23:59:59.999Z" });
  });

  it("saved snapshots are secondary: absent means null, present means series facts scoped to the interval", () => {
    expect(d.snapshots).toBeNull();
    let withSnaps = M.addSignatureSnapshot(m, computeSignature(evaluateSystem(m, { now: "2026-02-01T00:00:00.000Z" }), { id: "s1", now: "2026-02-01T00:00:00.000Z", mode: "current" }));
    withSnaps = M.addSignatureSnapshot(withSnaps, computeSignature(evaluateSystem(withSnaps, { now: "2026-10-01T00:00:00.000Z" }), { id: "s2", now: "2026-10-01T00:00:00.000Z", mode: "current" }));
    withSnaps = M.addSignatureSnapshot(withSnaps, computeSignature(evaluateSystem(withSnaps, { now: "2027-03-01T00:00:00.000Z" }), { id: "s3", now: "2027-03-01T00:00:00.000Z", mode: "current" }));
    const s = describeInterval(withSnaps, { ...YEAR, now: NOW }).snapshots!;
    expect(s.snapshotsTotal).toBe(2); // 2027 is outside the interval
    expect(s.first?.snapshotId).toBe("s1");
    expect(s.last?.snapshotId).toBe("s2");
    const a = s.dimensions.find((x) => x.dimensionId === "a_level")!;
    expect(a.recordedIn).toBe(2);
    expect(a.statement).toMatch(/recorded in 2 of 2 saved snapshots/);
    expect(a.statement).toMatch(/Nothing is known about the time between snapshots/);
    const c = s.variables.find((x) => x.variableId === "repeated_c")!;
    expect(c).toMatchObject({ recordedIn: 2, allEqual: true, rawRange: 0 });
    expect(c.statement).toMatch(/the same value \(5\) each time/);
    expect("persistent" in a).toBe(false);
  });
});

/** The neutral domain from the neutral-domain proof, rebuilt here. */
const NEUTRAL: DomainDefinition = {
  ...SYNTH,
  id: "neutral_interval_test",
  name: "Neutral (interval test)",
  variables: SYNTH.variables.slice(0, 2),
  derived: [],
  signatureDefinition: SignatureDefinitionSchema.parse({ ...SYNTH.signatureDefinition, id: "n_v1", domainId: "neutral_interval_test" }),
};
domainRegistry.register(NEUTRAL);

describe("describeInterval on a neutral domain with no collections, no presets, no household anything", () => {
  it("answers with the same buckets and empty context where nothing repeated", () => {
    let m = createBlankModel({ id: "n", name: "N", systemType: "unit", now: "2025-01-01T00:00:00.000Z", domain: NEUTRAL });
    m = M.addVariable(m, { ...input("changing_a", "changing_a", "n", 1, "2026-02-01") });
    m = M.recordValue(m, "changing_a", { value: 2, sourceType: "measured", confidence: 0.9, valid: date("2026-08-01") });
    m = M.addVariable(m, { ...input("changing_b", "changing_b", "n", 4, "2026-02-01") });
    m = M.recordValue(m, "changing_b", { value: 4, sourceType: "measured", confidence: 0.9, valid: date("2026-08-01") });
    const d = describeInterval(m, YEAR);
    expect(ids(d.buckets.changed)).toEqual(["changing_a"]);
    expect(ids(d.buckets.repeated)).toEqual(["changing_b"]);
    expect(d.context).toEqual([{ variableId: "changing_b", variablesChanged: ["changing_a"], eventsInInterval: 0 }]);
    expect(d.events).toEqual({ inInterval: [], unorderable: [], outsideInterval: 0 });
    expect(d.snapshots).toBeNull();
    expect(d.recomputed).toEqual([]);
  });
});

describe("describeInterval on the household sample with enriched histories", () => {
  function enriched(): SystemModel {
    let m = createSampleHousehold();
    // reserves change across the year; protected hours for Dani recorded three times at the same value;
    // the sample's own entries are valid from 2026-09-01 (asserted).
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 1800, sourceType: "measured", confidence: 0.9, valid: date("2026-01-15") });
    m = M.recordValue(m, INPUT_IDS.liquidReserves, { value: 2100, sourceType: "measured", confidence: 0.9, valid: date("2026-05-15") });
    // the sample stores its member-scoped input under the bare key with a subjectId;
    // its own entry is valid from September, so the same value is recorded in January and May
    const hours = INPUT_IDS.protectedHours;
    const sameValue = M.currentValueOf(m.variables.find((v) => v.id === hours)!) as number;
    m = M.recordValue(m, hours, { value: sameValue, sourceType: "self_reported", confidence: 0.6, valid: date("2026-01-20") });
    m = M.recordValue(m, hours, { value: sameValue, sourceType: "self_reported", confidence: 0.6, valid: date("2026-05-20") });
    return m;
  }
  const hoursSubject = (m: SystemModel) => m.variables.find((v) => v.id === INPUT_IDS.protectedHours)!.subjectId as string;

  it("finds the repeated condition, lists the changed variables as its context, and excludes calculated variables", () => {
    const m = enriched();
    const dani = INPUT_IDS.protectedHours;
    const d = describeInterval(m, { ...YEAR, now: NOW });
    expect(ids(d.buckets.repeated)).toContain(dani);
    expect(ids(d.buckets.changed)).toContain(INPUT_IDS.liquidReserves);
    const ctx = d.context.find((c) => c.variableId === dani)!;
    expect(ctx.variablesChanged).toContain(INPUT_IDS.liquidReserves);
    expect(ctx.eventsInInterval).toBe(m.events.length); // both sample events fall in 2026
    // sample-only variables have a single September entry: insufficient, never "stable"
    expect(ids(d.buckets.insufficient)).toContain(INPUT_IDS.totalDebt);
    expect(d.variables.some((v) => v.description.variableId === DERIVED_IDS.bufferMonths)).toBe(false);
    // the repeated sentence is descriptive
    const s = d.variables.find((v) => v.description.variableId === dani)!.sentences;
    expect(s.headline).toMatch(/the same value \(.+\) recorded on 3 dates, Jan 2026 → Sep 2026/);
    expect(s.details.join(" ")).toMatch(/does not show that the value held between the dates/);
  });

  it("a member filter keeps one person's variables; derived recomputation is caveated and separate", () => {
    const m = enriched();
    const who = hoursSubject(m);
    const d = describeInterval(m, { ...YEAR, subjectId: who, includeDerived: true, now: NOW });
    expect(d.variables.every((v) => v.description.subjectId === who)).toBe(true);
    expect(d.variables.some((v) => v.description.variableId === INPUT_IDS.protectedHours)).toBe(true);
    expect(d.recomputed.every((r) => r.subjectId === who && r.caveat === DERIVED_RECOMPUTATION_CAVEAT)).toBe(true);
    // the system-level recomputation has the household's system-scope calculated variables
    const sys = describeInterval(m, { ...YEAR, subjectId: m.id, includeDerived: true, now: NOW });
    expect(sys.recomputed.map((r) => r.variableId)).toContain(DERIVED_IDS.bufferMonths);
    expect(sys.recomputed.every((r) => r.subjectId === m.id && r.caveat === DERIVED_RECOMPUTATION_CAVEAT)).toBe(true);
  });

  it("the semantic parity of the sample is untouched: describing an interval mutates nothing", () => {
    const m = enriched();
    const before = JSON.stringify(m);
    describeInterval(m, { ...YEAR, includeDerived: true, lowVariation: A23, now: NOW });
    expect(JSON.stringify(m)).toBe(before);
  });
});
