import { describe, expect, it } from "vitest";
import {
  annualToMonthlyRate,
  careerCapitalStep,
  productiveCapitalStep,
  projectCareerCapital,
  projectProductiveCapital,
  projectSeries,
  weeklyToMonthlyHours,
} from "@/calculations/compounding";

describe("A6 career capital", () => {
  it("adds rate*q*h*p and subtracts switching cost", () => {
    expect(
      careerCapitalStep(35, { qualityOfEffort: 0.5, protectedHoursPerMonth: 8.66, persistence: 0.6, effortToCapitalRate: 0.1, switchingCostPerMonth: 1 }),
    ).toBeCloseTo(35 + 0.1 * 0.5 * 8.66 * 0.6 - 1, 9);
  });
  it("never goes below zero", () => {
    expect(careerCapitalStep(1, { qualityOfEffort: 0, protectedHoursPerMonth: 0, persistence: 0, effortToCapitalRate: 1, switchingCostPerMonth: 5 })).toBe(0);
  });
  it("projects a series with index 0 = start", () => {
    const s = projectCareerCapital(10, 3, { qualityOfEffort: 1, protectedHoursPerMonth: 2, persistence: 1, effortToCapitalRate: 1, switchingCostPerMonth: 0 });
    expect(s).toEqual([10, 12, 14, 16]);
  });
});

describe("A7 productive capital", () => {
  it("converts only positive surplus and applies return on existing capital", () => {
    expect(productiveCapitalStep(1000, { capitalConversionRate: 0.5, monthlyIncome: 5000, monthlyExpenses: 4000, monthlyReturnRate: 0.01 })).toBeCloseTo(
      1000 + 0.5 * 1000 + 10,
      9,
    );
  });
  it("a deficit contributes nothing (never negative conversion)", () => {
    expect(productiveCapitalStep(1000, { capitalConversionRate: 0.5, monthlyIncome: 3000, monthlyExpenses: 4000, monthlyReturnRate: 0 })).toBe(1000);
  });
  it("projects over months", () => {
    const s = projectProductiveCapital(100, 2, { capitalConversionRate: 1, monthlyIncome: 200, monthlyExpenses: 100, monthlyReturnRate: 0 });
    expect(s).toEqual([100, 200, 300]);
  });
});

describe("helpers", () => {
  it("projectSeries passes the month index", () => {
    expect(projectSeries(0, 3, (v, m) => v + m)).toEqual([0, 0, 1, 3]);
  });
  it("A15 weekly to monthly hours uses 4.33", () => {
    expect(weeklyToMonthlyHours(2)).toBeCloseTo(8.66, 9);
  });
  it("annual to monthly rate compounds back to the annual rate", () => {
    const m = annualToMonthlyRate(0.05);
    expect(Math.pow(1 + m, 12)).toBeCloseTo(1.05, 9);
    expect(annualToMonthlyRate(0)).toBe(0);
  });
});
