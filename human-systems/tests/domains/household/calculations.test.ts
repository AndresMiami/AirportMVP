import { describe, expect, it } from "vitest";
import {
  bufferMonths,
  debtBurden,
  failureCorrelation,
  floorRatio,
  incomeConcentration,
  incomeShares,
  incomeVolatility,
  monthlySurplus,
  reliableIncomeFloor,
  replacementLatency,
  totalMonthlyIncome,
} from "@/domains/household/calculations";
import type { IncomeSource } from "@/domains/household/income";

const src = (over: Partial<IncomeSource>): IncomeSource => ({
  id: "x",
  name: "x",
  earner: "",
  earnerId: null,
  monthlyAmount: 1000,
  reliability: 1,
  volatility: 0,
  correlationGroup: "g",
  replacementLatencyMonths: 1,
  sourceType: "measured",
  confidence: 1,
  evidence: [],
  notes: "",
  ...over,
});

const three = [
  src({ id: "a", monthlyAmount: 2600, reliability: 0.85, volatility: 0.1, correlationGroup: "emp", replacementLatencyMonths: 2 }),
  src({ id: "b", monthlyAmount: 1400, reliability: 0.5, volatility: 0.5, correlationGroup: "gig", replacementLatencyMonths: 0.5 }),
  src({ id: "c", monthlyAmount: 300, reliability: 0.2, volatility: 0.9, correlationGroup: "gig", replacementLatencyMonths: 1 }),
];

describe("income aggregates", () => {
  it("totals gross amounts", () => {
    expect(totalMonthlyIncome(three)).toBe(4300);
    expect(totalMonthlyIncome([])).toBe(0);
  });
  it("A1: reliable floor = sum(amount x reliability)", () => {
    expect(reliableIncomeFloor(three)).toBeCloseTo(2600 * 0.85 + 1400 * 0.5 + 300 * 0.2, 6);
  });
  it("shares sum to one and are empty without income", () => {
    const shares = incomeShares(three);
    expect(shares.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
    expect(incomeShares([src({ monthlyAmount: 0 })])).toEqual([]);
  });
  it("A3: HHI is 1 for one source, 1/n for n equal sources, null without income", () => {
    expect(incomeConcentration([src({})])).toBeCloseTo(1, 9);
    expect(incomeConcentration([src({ id: "a" }), src({ id: "b" }), src({ id: "c" }), src({ id: "d" })])).toBeCloseTo(0.25, 9);
    expect(incomeConcentration(three)).toBeCloseTo((2600 / 4300) ** 2 + (1400 / 4300) ** 2 + (300 / 4300) ** 2, 9);
    expect(incomeConcentration([])).toBeNull();
  });
  it("A4: failure correlation = largest correlated block", () => {
    // emp = 2600/4300; gig = 1700/4300 -> emp is largest
    expect(failureCorrelation(three)).toBeCloseTo(2600 / 4300, 9);
    const gigHeavy = [three[0], src({ id: "b", monthlyAmount: 3000, correlationGroup: "gig" })];
    expect(failureCorrelation(gigHeavy)).toBeCloseTo(3000 / 5600, 9);
    expect(failureCorrelation([])).toBeNull();
  });
  it("A5: share-weighted volatility and replacement latency", () => {
    expect(incomeVolatility(three)).toBeCloseTo((2600 * 0.1 + 1400 * 0.5 + 300 * 0.9) / 4300, 9);
    expect(replacementLatency(three)).toBeCloseTo((2600 * 2 + 1400 * 0.5 + 300 * 1) / 4300, 9);
    expect(incomeVolatility([])).toBeNull();
    expect(replacementLatency([])).toBeNull();
  });
});

describe("ratios", () => {
  it("floor ratio and buffer months divide by essential expenses", () => {
    expect(floorRatio(2970, 3600)).toBeCloseTo(0.825, 9);
    expect(bufferMonths(2800, 3600)).toBeCloseTo(0.7778, 3);
  });
  it("return null when expenses are zero or negative", () => {
    expect(floorRatio(1000, 0)).toBeNull();
    expect(bufferMonths(1000, -5)).toBeNull();
  });
  it("monthly surplus subtracts every expense class and can be negative", () => {
    expect(monthlySurplus({ totalIncome: 4300, essentialExpenses: 3600, discretionaryExpenses: 400, debtPayments: 320 })).toBe(-20);
  });
  it("debt burden is payments over income, null without income", () => {
    expect(debtBurden(320, 4300)).toBeCloseTo(320 / 4300, 9);
    expect(debtBurden(320, 0)).toBeNull();
  });
});
