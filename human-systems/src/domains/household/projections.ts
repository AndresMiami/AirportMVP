/**
 * Household domain: step-model projections drawn on the scenario screen,
 * labelled model assumptions (A6, A7). A projection with any unknown input
 * is skipped by the engine, never zero-filled.
 */
import { annualToMonthlyRate, projectCareerCapital, projectProductiveCapital, weeklyToMonthlyHours } from "@/calculations/compounding";
import type { ProjectionDefinition } from "@/model/domain";
import { DERIVED_IDS as D, INPUT_IDS as I } from "./keys";

export const HOUSEHOLD_PROJECTIONS: ProjectionDefinition[] = [
  {
    id: "career_capital",
    label: "Career capital (index)",
    unit: "index",
    assumptionIds: ["A6", "A15"],
    scope: "member",
    inputs: [
      { key: I.careerCapital, scope: "member" },
      { key: I.qualityOfEffort, scope: "member" },
      { key: I.protectedHours, scope: "member" },
      { key: I.persistence, scope: "member" },
      { key: I.switchingFrequency, scope: "member" },
      { key: I.effortToCapitalRate, scope: "system" },
      { key: I.switchingCost, scope: "system" },
    ],
    compute: (v, months) =>
      projectCareerCapital(v.get(I.careerCapital)!, months, {
        qualityOfEffort: v.get(I.qualityOfEffort)!,
        protectedHoursPerMonth: weeklyToMonthlyHours(v.get(I.protectedHours)!),
        persistence: v.get(I.persistence)!,
        effortToCapitalRate: v.get(I.effortToCapitalRate)!,
        switchingCostPerMonth: (v.get(I.switchingCost)! * v.get(I.switchingFrequency)!) / 12,
      }),
  },
  {
    id: "productive_assets",
    label: "Productive assets",
    unit: "$",
    assumptionIds: ["A7"],
    scope: "system",
    inputs: [
      { key: I.productiveAssets, scope: "system" },
      { key: D.totalIncome, scope: "system" },
      { key: I.essentialExpenses, scope: "system" },
      { key: I.discretionaryExpenses, scope: "system" },
      { key: I.monthlyDebtPayments, scope: "system" },
      { key: I.capitalConversionRate, scope: "system" },
      { key: I.annualReturnRate, scope: "system" },
    ],
    compute: (v, months) =>
      projectProductiveCapital(v.get(I.productiveAssets)!, months, {
        capitalConversionRate: v.get(I.capitalConversionRate)!,
        monthlyIncome: v.get(D.totalIncome)!,
        monthlyExpenses: v.get(I.essentialExpenses)! + v.get(I.discretionaryExpenses)! + v.get(I.monthlyDebtPayments)!,
        monthlyReturnRate: annualToMonthlyRate(v.get(I.annualReturnRate)!),
      }),
  },
];
