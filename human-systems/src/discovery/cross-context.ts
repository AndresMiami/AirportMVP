/**
 * CROSS-CONTEXT RECURRENCE — the deterministic core of "Explore this
 * pattern". For a repeated value y* of one input variable Y:
 *
 *     O = { t : Y(t) = y* }   occurrences
 *     C = { t : Y(t) != y* }  contrasts (Y recorded at another KNOWN value)
 *
 * and for every other in-scope input Z:
 *
 *     common          Z asserted the same at every occurrence
 *     background      ... and the same in the usable contrasts (present whether Y occurred or not)
 *     differentiating ... and demonstrably different in every usable contrast
 *     mixed           ... and different in some usable contrasts, the same in others
 *     undecided       ... and no usable contrast reading exists
 *
 * ABSENCE IS NOT DIFFERENCE: an unknown, ambiguous or merely carried
 * forward contrast reading never counts as "different". RESOLUTION !=
 * OBSERVATION: a value the resolver carries forward never counts toward
 * "the same at every occurrence". Occurrences keep their own temporal
 * EXTENT (a date, an approximate month, a stated range); context evidence
 * is whatever OVERLAPS that extent, never what resolves at a fabricated
 * midnight. Nothing here is a cause, a score or a ranking.
 */
import { temporalInterval } from "@/calculations/time";
import { resolveValue } from "@/model/history";
import type { StoredVariable, SystemModel, TemporalRef, ValidBasis } from "@/types";
import { describeVariableHistory, type Caveat } from "./describe-history";
import { eventContext, type EventContext } from "./describe-interval";
import { containsForbiddenPhrase, formatValue } from "./language";
import { extentInstants, type IntervalRequest } from "./interval";

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** The ACTUAL repeated record: one value of one variable at named times. */
export interface PatternRef {
  variableId: string;
  /** Must be attributed: the system id or a subject id. null (unassigned) is refused. */
  subjectId: string | null;
  interval: IntervalRequest;
  repeatedValue: number;
  /** Application times (normalized instants) where repeatedValue was recorded; >= 2. */
  occurrenceTimes: string[];
}

/** The occurrence's own asserted temporal extent — never a fabricated point. */
export interface ApplicationExtent {
  start: string;
  end: string;
  kind: TemporalRef["kind"];
  precision: TemporalRef["precision"];
  text: string;
}

export type ContextBasis =
  /** A record whose asserted extent covers or overlaps the occurrence extent. */
  | "asserted_coverage"
  /** Same, but the record's date is known only from when it was recorded (validBasis "recorded"). */
  | "recorded_basis_coverage"
  /** A stored range assertion overlapping the occurrence extent. */
  | "explicit_range_coverage"
  /** Nothing overlaps; the resolver carries an earlier value forward. Not evidence about this occurrence. */
  | "carried_forward_only"
  /** Distinct dated values inside one broad (approximate or stated) occurrence
   *  extent: the condition varied during the extent, so no single value can
   *  be assigned to the occurrence. Not a conflict. */
  | "varied_within_extent"
  | "unknown"
  /** Conflicting records competing for the SAME application time. */
  | "ambiguous";

export interface ContextReading {
  variableId: string;
  value: number | null;
  basis: ContextBasis;
  entryIds: string[];
  validBasis: ValidBasis | null;
}

export interface Slice {
  role: "occurrence" | "contrast";
  application: ApplicationExtent;
  patternValue: number;
  /** All identical records at this application time (History collapses them to one time). */
  patternEntryIds: string[];
  context: ContextReading[];
  eventsNear: EventContext[];
}

export type OccurrenceReading = "common" | "differing" | "insufficient";
/** What the usable contrasts show, independent of how many were usable. */
export type ContrastShows = "same" | "different" | "mixed" | "none";
/** How much of the contrast evidence was usable: every contrast time, some, or none. */
export type ContrastCoverage = "complete" | "partial" | "none";

export interface ConditionAssessment {
  variableId: string;
  name: string;
  unit: string;
  occurrenceValues: (number | null)[];
  occurrenceBases: ContextBasis[];
  occurrenceUsable: number;
  occurrenceTotal: number;
  atOccurrences: OccurrenceReading;
  commonValue: number | null;
  contrastTotal: number;
  contrastUsable: number;
  contrastSame: number;
  contrastDifferent: number;
  /** Direction from the usable contrasts, and coverage, kept INDEPENDENT:
   *  "different" with "partial" coverage is not a fully distinguished case. */
  contrastShows: ContrastShows;
  contrastCoverage: ContrastCoverage;
  /** The common reading rests partly on recorded-basis dates (from the
   *  readings' own validBasis, whatever their temporal shape). */
  reliesOnRecordedBasis: boolean;
  statement: string;
}

export interface CrossContext {
  ok: true;
  pattern: PatternRef;
  variableName: string;
  unit: string;
  /** Events are gathered inside this window around each occurrence extent: a display convention. */
  window: { days: number; convention: "display" };
  occurrences: Slice[];
  contrasts: Slice[];
  contrastNote: "none_recorded" | "available";
  conditions: ConditionAssessment[];
  /** FACTUAL groups only. Contrast groups carry their coverage in their
   *  name so partial evidence is never filed as a complete distinction. */
  groups: {
    differingAtOccurrences: string[];
    commonAtOccurrences: string[];
    insufficientAtOccurrences: string[];
    /** common + same in ALL contrast times */
    backgroundComplete: string[];
    /** common + different in ALL contrast times */
    differentiatingComplete: string[];
    /** common + mixed over ALL contrast times */
    mixedComplete: string[];
    /** common + some contrast times unreadable, whatever the readable ones show */
    contrastPartial: string[];
    /** common + no usable contrast reading */
    undecided: string[];
  };
  statements: string[];
  caveats: Caveat[];
}

export type CrossContextRefusal = {
  ok: false;
  reason: "unassigned_subject" | "unknown_variable" | "derived_variable" | "pattern_mismatch" | "not_recurring";
  message: string;
};

export interface CrossContextOptions {
  /** Days on each side of an occurrence extent inside which events count as "near" (default 30). */
  eventWindowDays?: number;
  /** Subjects whose input variables AND events form the context; default: the
   *  pattern's subject plus the system. Another subject's event near the
   *  pattern, or an unassigned event, is never context by default. */
  contextSubjectIds?: string[];
}

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function shift(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

function extentOf(t: TemporalRef): ApplicationExtent | null {
  const raw = temporalInterval(t);
  if (!raw) return null;
  const inst = extentInstants(raw);
  return { start: inst.start, end: inst.end, kind: t.kind, precision: t.precision, text: t.text };
}

/** What Z says about an occurrence extent: the records whose own extent
 *  overlaps it, else the resolver's carry-forward, else unknown. */
function readContext(z: StoredVariable, extent: ApplicationExtent): ContextReading {
  const active = z.values.filter((e) => e.status === "active");
  const overlapping = active
    .map((e) => ({ e, x: extentOf(e.valid) }))
    .filter((r): r is { e: (typeof active)[number]; x: ApplicationExtent } => r.x !== null && r.x.start <= extent.end && r.x.end >= extent.start);
  if (overlapping.length > 0) {
    const entryIds = overlapping.map((r) => r.e.id);
    // Conflicting records for the SAME application time are ambiguous (the
    // resolver's rule). Distinct dated values at DIFFERENT times inside a
    // broad occurrence extent are not a conflict: the condition varied.
    const byStart = new Map<string, Set<string>>();
    for (const r of overlapping) {
      if (!byStart.has(r.x.start)) byStart.set(r.x.start, new Set());
      byStart.get(r.x.start)!.add(JSON.stringify(r.e.value));
    }
    if ([...byStart.values()].some((p) => p.size > 1)) return { variableId: z.id, value: null, basis: "ambiguous", entryIds, validBasis: null };
    const payloads = new Set(overlapping.map((r) => JSON.stringify(r.e.value)));
    if (payloads.size > 1) return { variableId: z.id, value: null, basis: "varied_within_extent", entryIds, validBasis: null };
    const value = overlapping[0].e.value;
    if (value === null) return { variableId: z.id, value: null, basis: "unknown", entryIds, validBasis: overlapping[0].e.validBasis };
    const anyRange = overlapping.some((r) => r.e.valid.kind === "range");
    const anyRecorded = overlapping.some((r) => r.e.validBasis === "recorded");
    return {
      variableId: z.id,
      value,
      basis: anyRange ? "explicit_range_coverage" : anyRecorded ? "recorded_basis_coverage" : "asserted_coverage",
      entryIds,
      validBasis: anyRecorded ? "recorded" : "asserted",
    };
  }
  const r = resolveValue(active, extent.end);
  if (r.state === "ambiguous") return { variableId: z.id, value: null, basis: "ambiguous", entryIds: r.candidates.map((c) => c.id), validBasis: null };
  if (r.entry && r.entry.value !== null) return { variableId: z.id, value: r.entry.value, basis: "carried_forward_only", entryIds: [r.entry.id], validBasis: r.entry.validBasis };
  return { variableId: z.id, value: null, basis: "unknown", entryIds: r.entry ? [r.entry.id] : [], validBasis: r.entry?.validBasis ?? null };
}

const USABLE: ReadonlySet<ContextBasis> = new Set(["asserted_coverage", "recorded_basis_coverage", "explicit_range_coverage"]);
const usable = (c: ContextReading) => USABLE.has(c.basis) && c.value !== null;

function assess(z: StoredVariable, occurrences: Slice[], contrasts: Slice[]): ConditionAssessment {
  const occ = occurrences.map((s) => s.context.find((c) => c.variableId === z.id)!);
  const con = contrasts.map((s) => s.context.find((c) => c.variableId === z.id)!);
  const occUsable = occ.filter(usable);
  const values = occUsable.map((c) => c.value as number);
  const allUsable = occUsable.length === occ.length;
  const atOccurrences: OccurrenceReading = !allUsable ? "insufficient" : new Set(values).size === 1 ? "common" : "differing";
  const commonValue = atOccurrences === "common" ? values[0] : null;
  const conUsable = con.filter(usable);
  const same = commonValue === null ? 0 : conUsable.filter((c) => c.value === commonValue).length;
  const different = commonValue === null ? 0 : conUsable.filter((c) => c.value !== commonValue).length;
  const contrastShows: ContrastShows = atOccurrences !== "common" || conUsable.length === 0 ? "none" : different === 0 ? "same" : same === 0 ? "different" : "mixed";
  const contrastCoverage: ContrastCoverage = con.length === 0 || conUsable.length === 0 ? "none" : conUsable.length === con.length ? "complete" : "partial";
  // Epistemic basis is independent of temporal shape: a stored RANGE whose
  // date is known only from its recording still rests on recorded basis.
  const reliesOnRecordedBasis = atOccurrences === "common" && occUsable.some((c) => c.validBasis === "recorded");
  const fmt = (v: number | null) => formatValue(v, z.unit);
  const nO = occ.length;
  const nC = con.length;
  const nUnusableC = nC - conUsable.length;
  const unresolvedCases = occ.filter((c) => !usable(c)).length + nUnusableC;
  const unresolvedKinds = [...occ, ...con].filter((c) => !usable(c)).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.basis]: (acc[c.basis] ?? 0) + 1 }), {});
  // Counts are of relevant CASES (occurrence or contrast readings), never of
  // source records: one conflict can carry into several later readings.
  const KIND_WORDS: Record<string, string> = { carried_forward_only: "with only an older value standing", unknown: "recorded as unknown or not recorded", ambiguous: "with conflicting records for the same time", varied_within_extent: "that varied within the occurrence period" };
  const breakdown = Object.entries(unresolvedKinds).map(([k, n]) => `${n} case${n === 1 ? "" : "s"} ${KIND_WORDS[k] ?? k}`).join(", ");
  const readable = `${conUsable.length} readable contrast time${conUsable.length === 1 ? "" : "s"}`;
  const others = `${nUnusableC} other contrast time${nUnusableC === 1 ? " is" : "s are"} unresolved`;
  let statement: string;
  if (atOccurrences === "insufficient") {
    statement = `${z.name} is unresolved in ${unresolvedCases} of ${nO + nC} relevant cases (${occUsable.length} of ${nO} occurrences readable; ${breakdown}); not enough evidence to compare.`;
  } else if (atOccurrences === "differing") {
    statement = `${z.name} differed across the ${nO} occurrences (${[...new Set(values)].map(fmt).join(", ")}).`;
  } else {
    const base = `${z.name} was recorded at ${fmt(commonValue)} at all ${nO} occurrences`;
    const recordedNote = reliesOnRecordedBasis ? " (relying partly on dates known only from when the information was recorded)" : "";
    const complete = contrastCoverage === "complete";
    switch (contrastShows) {
      case "same":
        statement = complete
          ? `${base} and at all ${nC} contrast time${nC === 1 ? "" : "s"}${recordedNote}; present whether the pattern occurred or not, so it does not by itself distinguish the cases.`
          : `${base} and the same at the ${readable}${recordedNote}; ${others}, so whether it distinguishes the cases remains open.`;
        break;
      case "different":
        statement = complete
          ? `${base} and different at all ${nC} contrast time${nC === 1 ? "" : "s"}${recordedNote}; this distinguishes the recorded cases. Recorded together is not caused by.`
          : `${base} and different at the ${readable}${recordedNote}; ${others}, so the comparison is incomplete.`;
        break;
      case "mixed":
        statement = complete
          ? `${base}${recordedNote}; the same at ${same} and different at ${different} of ${nC} contrast times, so the recorded cases are only partly distinguished.`
          : `${base}${recordedNote}; the same at ${same} and different at ${different} of the ${readable}; ${others}.`;
        break;
      default:
        statement = `${base}${recordedNote}; no usable contrast reading exists (${nC} contrast time${nC === 1 ? "" : "s"}, ${nUnusableC} unresolved), so whether it distinguishes the cases is undecided.`;
    }
  }
  return {
    variableId: z.id,
    name: z.name,
    unit: z.unit,
    occurrenceValues: occ.map((c) => c.value),
    occurrenceBases: occ.map((c) => c.basis),
    occurrenceUsable: occUsable.length,
    occurrenceTotal: nO,
    atOccurrences,
    commonValue,
    contrastTotal: nC,
    contrastUsable: conUsable.length,
    contrastSame: same,
    contrastDifferent: different,
    contrastShows,
    contrastCoverage,
    reliesOnRecordedBasis,
    statement,
  };
}

/**
 * Compute the cross-context recurrence for a pattern reference. Data
 * conditions (unassigned subject, a reference that no longer matches the
 * records) are typed refusals, not exceptions.
 */
export function crossContext(model: SystemModel, pattern: PatternRef, options: CrossContextOptions = {}): CrossContext | CrossContextRefusal {
  if (pattern.subjectId === null) {
    return { ok: false, reason: "unassigned_subject", message: "Assign this record to a subject before exploring its surrounding context." };
  }
  const y = model.variables.find((v) => v.id === pattern.variableId);
  if (!y) return { ok: false, reason: "unknown_variable", message: `No variable "${pattern.variableId}" in this system.` };
  if (y.kind !== "input") return { ok: false, reason: "derived_variable", message: `${y.name} is a calculated variable; only recorded values can be explored.` };
  if (y.subjectId !== pattern.subjectId) return { ok: false, reason: "pattern_mismatch", message: `${y.name} is not attributed to the subject the pattern names.` };

  const history = describeVariableHistory(y, pattern.interval);
  const times = history.applicationTimes.filter((t) => t.kind === "known");
  const occurrenceTimes = times.filter((t) => t.value === pattern.repeatedValue).map((t) => t.start);
  if (occurrenceTimes.length < 2) {
    return { ok: false, reason: "not_recurring", message: `${y.name} was not recorded at ${formatValue(pattern.repeatedValue, y.unit)} at two or more dates in this period.` };
  }
  const sameTimes = pattern.occurrenceTimes.length === occurrenceTimes.length && [...pattern.occurrenceTimes].sort().every((t, i) => t === [...occurrenceTimes].sort()[i]);
  if (!sameTimes) {
    return { ok: false, reason: "pattern_mismatch", message: "The records no longer match this pattern; open it again from History." };
  }

  const windowDays = options.eventWindowDays ?? 30;
  const contextSubjects = new Set(options.contextSubjectIds ?? [pattern.subjectId, model.id]);
  const contextVars = model.variables.filter((v) => v.kind === "input" && v.id !== y.id && v.subjectId !== null && contextSubjects.has(v.subjectId));
  const byId = new Map(history.records.map((r) => [r.entryId, r]));

  const slice = (t: (typeof times)[number], role: Slice["role"]): Slice => {
    const recs = t.entryIds.map((id) => byId.get(id)!);
    const start = recs.map((r) => r.validStart as string).sort()[0];
    const end = recs.map((r) => r.validEnd as string).sort().at(-1) as string;
    const first = y.values.find((e) => e.id === recs[0].entryId)!;
    const application: ApplicationExtent = { start, end, kind: first.valid.kind, precision: first.valid.precision, text: recs[0].validText };
    const near = { from: shift(start, -windowDays), to: shift(end, windowDays) };
    return {
      role,
      application,
      patternValue: t.value as number,
      patternEntryIds: t.entryIds,
      context: contextVars.map((z) => readContext(z, application)),
      eventsNear: model.events
        .filter((e) => e.subjectId !== null && contextSubjects.has(e.subjectId))
        .map((e) => eventContext(e, near))
        .filter((r) => r.inInterval)
        .map((r) => r.ctx),
    };
  };
  const occurrences = times.filter((t) => t.value === pattern.repeatedValue).map((t) => slice(t, "occurrence"));
  const contrasts = times.filter((t) => t.value !== pattern.repeatedValue).map((t) => slice(t, "contrast"));

  const conditions = contextVars.map((z) => assess(z, occurrences, contrasts));
  const groups: CrossContext["groups"] = { differingAtOccurrences: [], commonAtOccurrences: [], insufficientAtOccurrences: [], backgroundComplete: [], differentiatingComplete: [], mixedComplete: [], contrastPartial: [], undecided: [] };
  for (const c of conditions) {
    if (c.atOccurrences === "differing") groups.differingAtOccurrences.push(c.variableId);
    else if (c.atOccurrences === "insufficient") groups.insufficientAtOccurrences.push(c.variableId);
    else {
      groups.commonAtOccurrences.push(c.variableId);
      if (c.contrastCoverage === "none") groups.undecided.push(c.variableId);
      else if (c.contrastCoverage === "partial") groups.contrastPartial.push(c.variableId);
      else if (c.contrastShows === "same") groups.backgroundComplete.push(c.variableId);
      else if (c.contrastShows === "different") groups.differentiatingComplete.push(c.variableId);
      else groups.mixedComplete.push(c.variableId);
    }
  }

  const statements = [
    `${y.name} was recorded at ${formatValue(pattern.repeatedValue, y.unit)} at ${occurrences.length} dates; ${contrasts.length === 0 ? "no other known value was recorded in this period" : `it was recorded at other values at ${contrasts.length} date${contrasts.length === 1 ? "" : "s"}`}.`,
    ...conditions.map((c) => c.statement),
  ];
  const caveats: Caveat[] = [
    { code: "together_not_caused", text: "A condition recorded together with the pattern is a clue, not its cause; a condition present whether the pattern occurred or not does not by itself explain it." },
    { code: "absence_not_difference", text: "An unknown, ambiguous or merely carried-forward contrast reading never counts as different: absence of evidence is not evidence of difference." },
    { code: "resolution_not_observation", text: "A value the resolver carries forward to an occurrence is not evidence about that occurrence and never counts as recorded there." },
  ];
  if (contrasts.length === 0) caveats.push({ code: "no_contrasts", text: "No contrast case is recorded in this period, so nothing can be said about what distinguishes the occurrences." });
  if (conditions.some((c) => c.reliesOnRecordedBasis)) caveats.push({ code: "recorded_basis", text: "A common condition relies partly on dates known only from when the information was recorded, not necessarily when the condition began or was observed." });
  if (occurrences.some((s) => s.application.kind === "approx" || s.application.kind === "range")) caveats.push({ code: "extent_not_point", text: "Some occurrences are approximate or stated periods; context is read over their whole extent, never at a single instant." });
  const allReadings = [...occurrences, ...contrasts].flatMap((s) => s.context);
  if (allReadings.some((c) => c.basis === "varied_within_extent")) caveats.push({ code: "varied_within_extent", text: "Within an approximate or stated occurrence period, a condition was recorded at more than one value. No single value can be assigned to that occurrence; that is variation during the period, not conflicting records for the same time." });
  if (allReadings.some((c) => c.basis === "ambiguous")) caveats.push({ code: "ambiguous_context", text: "Two records claim different values for the same time; that time cannot be read until one is corrected or retracted." });
  for (const s of statements) {
    const bad = containsForbiddenPhrase(s);
    if (bad) throw new Error(`cross-context statement contains forbidden phrase "${bad}": ${s}`);
  }

  return {
    ok: true,
    pattern,
    variableName: y.name,
    unit: y.unit,
    window: { days: windowDays, convention: "display" },
    occurrences,
    contrasts,
    contrastNote: contrasts.length === 0 ? "none_recorded" : "available",
    conditions,
    groups,
    statements,
    caveats,
  };
}
