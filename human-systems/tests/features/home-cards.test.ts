/**
 * HOME CARDS (Step 6A): every card comes from a system that already
 * exists — the History engine, the proposal ledger, the canonical
 * hypotheses — and an empty system yields calm empties, never invented
 * insight. Neutral domain; household mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { describeVariableHistory, historySentenceFor } from "@/discovery";
import { homeQuantity, longDate, monthName, openProposalCount, recurrenceCards, recurrenceOverview, recurrenceSentence, workingHypotheses } from "@/features/home/cards";
import type { MutationProposal } from "@/kernel";
import { createBlankModel } from "@/model/blank";
import * as M from "@/services/mutations";
import { CC_DOMAIN, ccSystem } from "../helpers/cross-context-fixture";

const { armed } = vi.hoisted(() => ({
  armed: (name: string) => () => {
    throw new Error(`household module loaded at runtime: ${name}`);
  },
}));
vi.mock("@/domains/household", armed("@/domains/household"));
vi.mock("@/domains", armed("@/domains"));
vi.mock("@/data/sample-household", armed("@/data/sample-household"));
vi.mock("@/bootstrap/household-app", armed("@/bootstrap/household-app"));

describe("recurrenceCards", () => {
  it("comes from describeVariableHistory over each assigned input's recorded span; strongest repetition first; the Explore hand-off carries the exact pattern", () => {
    const m = ccSystem();
    const cards = recurrenceCards(m, "2026-09-16", 10);
    expect(cards.length).toBeGreaterThan(3);
    const y = cards.find((c) => c.variableId === "income_stability")!;
    expect(y.subjectId).toBe("p1");
    expect(y.occurrences).toBe(4);
    const d = describeVariableHistory(m.variables.find((v) => v.id === "income_stability")!, { from: "2025-02-10", to: "2026-09-16" });
    expect(y.headline).toBe(historySentenceFor(d, "repeated").headline);
    expect(y.exploreHref).toMatch(/^\/explore\?variable=income_stability&subject=p1&from=2025-02-10&to=2026-09-16&value=5&times=/);
    expect(y.historyHref).toBe("/history?from=2025-02-10&to=2026-09-16");
    // strongest first, at most the limit, never an unassigned or derived variable
    expect(cards[0].occurrences).toBeGreaterThanOrEqual(cards[cards.length - 1].occurrences);
    expect(recurrenceCards(m, "2026-09-16")).toHaveLength(3);
    expect(recurrenceCards(m, "2026-09-16").map((c) => c.variableId)).toEqual(cards.slice(0, 3).map((c) => c.variableId));
    expect(recurrenceCards(m, "2026-09-16", 1)).toHaveLength(1);
    expect(cards.some((c) => c.variableId === "unassigned")).toBe(false);
  });

  it("a system with nothing repeated yields no card (calm empty state), and a date before the records yields none", () => {
    const blank = createBlankModel({ id: "sys_b", name: "B", systemType: "unit", now: "2026-01-01T00:00:00.000Z", domain: CC_DOMAIN });
    expect(recurrenceCards(blank, "2026-09-16")).toEqual([]);
    expect(recurrenceCards(ccSystem(), "2024-01-01")).toEqual([]);
  });
});

describe("Home wording (6A.1) over the engine's facts", () => {
  it("formats quantities for people: currency leads with the sign, placeholder units vanish, other units follow the number", () => {
    expect(homeQuantity(4000, "$")).toBe("$4,000");
    expect(homeQuantity(150, "$/month")).toBe("$150 a month");
    expect(homeQuantity(-250.5, "$")).toBe("-$250.5");
    expect(homeQuantity(5, "u")).toBe("5");
    expect(homeQuantity(0.8, "")).toBe("0.8");
    expect(homeQuantity(1.5, "months")).toBe("1.5 months");
    expect(homeQuantity(12345.678, "index 0-1")).toBe("12,345.68 index 0-1");
  });
  it("says what repeated, how many recorded dates, and the calendar span — never record counts or application times", () => {
    const times = ["2026-06-01T00:00:00.000Z", "2025-02-10T00:00:00.000Z", "2025-07-10T00:00:00.000Z", "2026-01-10T00:00:00.000Z"];
    expect(recurrenceSentence("Total debt", 4000, "$", times)).toBe("Total debt was $4,000 on 4 recorded dates between February 2025 and June 2026.");
    expect(recurrenceSentence("Buffer", 1.5, "months", ["2025-02-10", "2025-02-20"])).toBe("Buffer was 1.5 months on 2 recorded dates in February 2025.");
    expect(recurrenceSentence("X", 1, "", ["2025-02-10"])).toBe("X was 1 on one recorded date in February 2025.");
    const card = recurrenceCards(ccSystem(), "2026-09-16", 10).find((c) => c.variableId === "income_stability")!;
    expect(card.sentence).toBe("income_stability was 5 on 4 recorded dates between February 2025 and June 2026.");
    expect(card.sentence).not.toMatch(/dated records|application times|distinct/);
    expect(card.headline).toMatch(/was recorded on 4 dates/); // History keeps its own sentence
  });
  it("dates read as calendar words, from the ISO fields only", () => {
    expect(monthName("2025-06-01")).toBe("June 2025");
    expect(longDate("2025-06-01")).toBe("June 1, 2025");
    expect(longDate("2026-12-25T23:59:00.000Z")).toBe("December 25, 2026");
  });
  it("Home gets one strongest pattern and a count of the rest; nothing when nothing repeats", () => {
    const o = recurrenceOverview(ccSystem(), "2026-09-16");
    expect(o.strongest?.variableId).toBe("autonomy_pref");
    // "N more patterns in History" counts the way History lists them: one pattern per repeated value (6F)
    const all = recurrenceCards(ccSystem(), "2026-09-16", 100);
    expect(o.more).toBe(all.reduce((n, c) => n + c.patternCount, 0) - 1);
    expect(all.reduce((n, c) => n + c.patternCount, 0)).toBeGreaterThan(all.length); // the fixture has a variable with two repeated values
    expect(o.more).toBeGreaterThan(1);
    expect(recurrenceOverview(ccSystem(), "2024-01-01")).toEqual({ strongest: null, more: 0 });
  });
});

describe("counts come from the ledger and the canonical model", () => {
  it("open proposals are proposed / reviewed / stale / failed / applying; hypotheses exclude rejected ones", () => {
    const mk = (status: MutationProposal["status"]) => ({ status }) as MutationProposal;
    expect(openProposalCount(["proposed", "reviewed", "stale", "failed", "applying", "applied", "rejected", "superseded"].map((s) => mk(s as MutationProposal["status"])))).toBe(5);
    expect(openProposalCount([])).toBe(0);
    let m = ccSystem();
    m = M.addHypothesis(m, { id: "h1", statement: "One", subjectId: "p1" });
    m = M.addHypothesis(m, { id: "h2", statement: "Two", subjectId: "p1", status: "rejected" });
    expect(workingHypotheses(m).map((h) => h.id)).toEqual(["h1"]);
  });
});
