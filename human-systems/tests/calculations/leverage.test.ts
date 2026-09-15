import { describe, expect, it } from "vitest";
import { LEVERAGE_FLOOR, leverageScore, rankByLeverage } from "@/calculations/leverage";

describe("A8 leverage score", () => {
  it("is (I*C*D)/(cost*uncertainty)", () => {
    const r = leverageScore({ impact: 0.8, controllability: 0.5, durability: 0.5, cost: 0.4, uncertainty: 0.5 });
    expect(r.score).toBeCloseTo((0.8 * 0.5 * 0.5) / (0.4 * 0.5), 9);
    expect(r.floored).toBe(false);
  });
  it("floors zero cost / uncertainty instead of dividing by zero", () => {
    const r = leverageScore({ impact: 1, controllability: 1, durability: 1, cost: 0, uncertainty: 0 });
    expect(r.score).toBeCloseTo(1 / (LEVERAGE_FLOOR * LEVERAGE_FLOOR), 9);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.floored).toBe(true);
  });
  it("clamps out-of-range and NaN inputs", () => {
    const r = leverageScore({ impact: 2, controllability: -1, durability: Number.NaN, cost: 1, uncertainty: 1 });
    expect(r.factors).toEqual({ impact: 1, controllability: 0, durability: 0, cost: 1, uncertainty: 1 });
    expect(r.score).toBe(0);
  });
  it("ranks descending and skips items without factors", () => {
    const items = [
      { id: "low", f: { impact: 0.1, controllability: 1, durability: 1, cost: 1, uncertainty: 1 } },
      { id: "none", f: null },
      { id: "high", f: { impact: 0.9, controllability: 1, durability: 1, cost: 1, uncertainty: 1 } },
    ];
    const ranked = rankByLeverage(items, (i) => i.f);
    expect(ranked.map((r) => r.item.id)).toEqual(["high", "low"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });
});
