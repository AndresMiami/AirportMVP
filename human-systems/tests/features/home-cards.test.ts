/**
 * HOME CARDS (Step 6A): every card comes from a system that already
 * exists — the History engine, the proposal ledger, the canonical
 * hypotheses — and an empty system yields calm empties, never invented
 * insight. Neutral domain; household mocked to throw.
 */
import { describe, expect, it, vi } from "vitest";
import { describeVariableHistory, historySentenceFor } from "@/discovery";
import { openProposalCount, recurrenceCards, workingHypotheses } from "@/features/home/cards";
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
