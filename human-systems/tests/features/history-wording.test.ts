/**
 * HISTORY WORDING (6B): three ordinary questions over the deterministic
 * interval description. Presentation only — every engine distinction keeps
 * its own row and tag, forbidden phrases never appear, and the Explore
 * hand-off is the exact PatternRef the original screen encoded. Neutral
 * domain; household mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { containsForbiddenPhrase, decodePatternRef, describeInterval, encodePatternRef, historySentenceFor } from "@/discovery";
import { eventWhen, explorePatternHref, GROUP_THRESHOLD, historyQuestions, historyRows, needsInformationGroups, periodSummary } from "@/features/history/wording";
import { plainQuantity, plainSpan } from "@/features/plain-language";
import { CC_DATE, CC_PATTERN, ccEntry, ccSystem, ccVariable } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

const A23 = { assumptionId: "A23" as const, tolerance: 0.1 };
const NOW = "2026-09-16T12:00:00.000Z";
const interval = (m = ccSystem()) => describeInterval(m, { from: "2025-02-10", to: "2026-09-16", lowVariation: A23, now: NOW });

describe("the three questions", () => {
  it("cover exactly the engine's buckets: one row per (variable, fact), one row per repeated value, tags for every distinction", () => {
    const d = interval();
    const q = historyQuestions(d);
    expect(q.changed.map((r) => r.variableId)).toEqual(d.buckets.changed.map((v) => v.description.variableId));
    const repeatedRows = d.buckets.repeated.reduce((n, v) => n + v.description.repeatedValues.length, 0);
    expect(q.recurring.filter((r) => r.lens === "repeated")).toHaveLength(repeatedRows);
    expect(q.recurring.filter((r) => r.lens === "low_variation")).toHaveLength(d.buckets.lowVariation.length);
    expect(q.recurring.filter((r) => r.lens === "explicit_claim")).toHaveLength(d.buckets.explicitClaims.length);
    expect(q.needsInformation).toHaveLength(d.buckets.lastKnownOnly.length + d.buckets.insufficient.length + d.buckets.unresolved.length);
    for (const r of [...q.changed, ...q.recurring, ...q.needsInformation]) {
      expect(containsForbiddenPhrase(r.text), r.text).toBeNull();
      expect(r.text).not.toMatch(/application time|dated records|A23|resolution|summaryClass|recorded variable|dated value/);
    }
    // 6B.1: counts appear only where the finding needs them — an exact repetition's recorded dates, a single recorded value
    for (const r of [...q.changed, ...q.recurring.filter((x) => x.lens !== "repeated")]) expect(r.text).not.toMatch(/across \d+ recorded values|\d+ recorded/);
    expect(q.changed.every((r) => r.tag === null)).toBe(true);
    expect(q.recurring.filter((r) => r.lens === "repeated").every((r) => r.tag === null)).toBe(true); // no "Same value" tag
    expect(new Set(q.recurring.filter((r) => r.lens !== "repeated").map((r) => r.tag))).toEqual(new Set([...(d.buckets.lowVariation.length ? ["Stayed close"] : []), ...(d.buckets.explicitClaims.length ? ["As stated"] : [])]));
    expect(q.needsInformation.every((r) => ["Old value still standing", "Not enough history", "Unknown"].includes(r.tag as string))).toBe(true);
  });

  it("hands Explore the EXACT PatternRef the original History screen encoded: variable, subject, requested interval, repeated value, occurrence times", () => {
    const d = interval();
    const v = d.variables.find((x) => x.description.variableId === "income_stability")!;
    const rows = historyRows(v.description, "repeated");
    const five = rows.find((r) => r.repeatedValue === 5)!;
    const rv = v.description.repeatedValues.find((r) => r.value === 5)!;
    const legacy = `/explore?${encodePatternRef({ variableId: "income_stability", subjectId: "p1", interval: { from: v.description.interval.requested.from, to: v.description.interval.requested.to }, repeatedValue: 5, occurrenceTimes: rv.applicationTimes })}`;
    expect(five.exploreHref).toBe(legacy);
    expect(decodePatternRef(new URLSearchParams(five.exploreHref!.slice("/explore?".length)))).toEqual({ ...CC_PATTERN, interval: { from: "2025-02-10", to: "2026-09-16" } });
    // one row per repeated value, each with its own hand-off; an unassigned record has none
    expect(rows.map((r) => r.repeatedValue)).toEqual(v.description.repeatedValues.map((r) => r.value));
    expect(explorePatternHref({ ...v.description, subjectId: null }, 5, rv.applicationTimes)).toBeNull();
  });

  it("words each lens for people while the engine keeps its own sentence under Details", () => {
    const d = interval();
    const income = d.variables.find((x) => x.description.variableId === "income_stability")!.description;
    expect(historyRows(income, "changed")[0].text).toBe("income_stability ranged from 5 to 9 between February 2025 and June 2026.");
    expect(historySentenceFor(income, "changed").details[0]).toMatch(/^\d+ of \d+ consecutive record pairs differ/); // the count stays under Details
    expect(historyRows(income, "repeated")[0].text).toBe("income_stability was 5 on 4 recorded dates between February 2025 and June 2026.");
    expect(historySentenceFor(income, "repeated").headline).toMatch(/was recorded on 4 dates/); // unchanged engine wording
    const cover = d.variables.find((x) => x.description.variableId === "health_cover")!.description;
    expect(historyRows(cover, "unresolved")[0]).toMatchObject({ question: "needs_information", tag: "Unknown", text: "health_cover is unknown for this period: it was recorded as unknown." });
    // nothing recorded in a later period: the old value still stands (a state, never an observation)
    const late = describeInterval(ccSystem(), { from: "2026-07-01", to: "2026-09-16", now: NOW });
    const buffer = late.variables.find((x) => x.description.variableId === "buffer")!.description;
    expect(historyRows(buffer, "last_known_only")[0]).toMatchObject({ tag: "Old value still standing", text: "buffer: nothing new was recorded in this period. The last recorded value, 1.5 months from June 2026, still stands because nothing replaced it." });
    const one = describeInterval(ccSystem(), { from: "2026-06-01", to: "2026-06-30", now: NOW });
    const inc1 = one.variables.find((x) => x.description.variableId === "income_stability")!.description;
    expect(historyRows(inc1, "insufficient")[0]).toMatchObject({ tag: "Not enough history", text: "income_stability has only one recorded value in this period in June 2026, so nothing can be said about it repeating." });
  });

  it("low recorded variation is worded as staying close and stays distinct from an exact repetition", () => {
    const base = ccSystem();
    const steadyVar = { ...ccVariable("steady", "p1", [10, 12, 14].map((value, i) => ccEntry(value, CC_DATE(["2025-12-01", "2026-03-01", "2026-06-01"][i]))), ""), name: "Steady", referenceRange: { min: 0, max: 100 } };
    const m = { ...base, variables: [...base.variables, steadyVar] };
    const d = describeInterval(m, { from: "2025-02-10", to: "2026-09-16", lowVariation: A23, now: NOW });
    const steady = d.variables.find((x) => x.description.variableId === "steady")!.description;
    expect(steady.facts.lowRecordedVariation).toBe(true);
    const row = historyRows(steady, "low_variation")[0];
    expect(row).toMatchObject({ question: "recurring", tag: "Stayed close", exploreHref: null });
    expect(row.text).toBe("Steady stayed between 10 and 14 between December 2025 and June 2026.");
    expect(historyRows(steady, "repeated")).toEqual([]);
  });

  it("groups the third question by distinction: a large group collapses to one sentence, nothing is dropped, small groups stay open", () => {
    const mk = (tag: string, i: number) => ({ key: `${tag}${i}`, variableId: `v${tag}${i}`, subjectId: null, lens: "insufficient" as const, question: "needs_information" as const, tag, text: `v${i} has only one recorded value in this period in September 2026, so nothing can be said about it repeating.`, exploreHref: null, repeatedValue: null });
    const rows = [...Array.from({ length: GROUP_THRESHOLD + 1 }, (_, i) => mk("Not enough history", i)), mk("Unknown", 0), mk("Old value still standing", 0)];
    const groups = needsInformationGroups(rows);
    expect(groups.map((g) => g.tag)).toEqual(["Old value still standing", "Not enough history", "Unknown"]);
    expect(groups.map((g) => g.collapsed)).toEqual([false, true, false]);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
    expect(groups[1].summary).toBe(`${GROUP_THRESHOLD + 1} variables have only one recorded value in this period (all in September 2026), so nothing can be said about them repeating.`);
    for (const g of groups) expect(containsForbiddenPhrase(g.summary)).toBeNull();
    expect(needsInformationGroups([])).toEqual([]);
  });

  it("event dates read as calendar words when the record is a plain date or range, and stay the person's own words otherwise (6G)", () => {
    expect(eventWhen({ occurredText: "2025-07-01", occurredStart: "2025-07-01T00:00:00.000Z", occurredEnd: "2025-07-01T00:00:00.000Z" })).toBe("July 1, 2025");
    expect(eventWhen({ occurredText: "2026-03-01 to 2026-08-31", occurredStart: null, occurredEnd: null })).toBe("March 2026 to August 2026");
    expect(eventWhen({ occurredText: "2026-03-01 to 2026-03-15", occurredStart: null, occurredEnd: null })).toBe("March 1, 2026 to March 15, 2026");
    expect(eventWhen({ occurredText: "Mar–Aug 2026 (two months within)", occurredStart: "2026-03-01T00:00:00.000Z", occurredEnd: "2026-08-31T00:00:00.000Z" })).toBe("Mar–Aug 2026 (two months within)");
    expect(eventWhen({ occurredText: "", occurredStart: "2026-03-01T00:00:00.000Z", occurredEnd: "2026-08-31T00:00:00.000Z" })).toBe("March 2026 to August 2026");
    expect(eventWhen({ occurredText: "", occurredStart: null, occurredEnd: null })).toBe("date not recorded");
  });

  it("quantities and spans read plainly; the period line counts what the engine counted", () => {
    expect(plainQuantity(null, "$")).toBe("unknown");
    expect(plainQuantity(4000, "$")).toBe("$4,000");
    expect(plainSpan([])).toBe("");
    expect(plainSpan(["2026-02-03", "2026-02-20"])).toBe(" in February 2026");
    const d = interval();
    expect(periodSummary(d)).toMatch(/^\d+ recorded variables, \d+ dated values and \d+ events?$/);
  });
});
