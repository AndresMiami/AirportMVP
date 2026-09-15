/**
 * Household domain: its own MODEL ASSUMPTIONS (economic and career
 * conventions). Ids A1–A7 and A15 are historical and stay unique across the
 * generic registry so provenance recorded before the split still resolves.
 */
import type { ModelAssumption } from "@/domain/assumptions";

export const HOUSEHOLD_ASSUMPTIONS: ModelAssumption[] = [
  {
    id: "A1",
    title: "Reliable income floor",
    statement:
      "Floor = sum over sources of (monthly amount x reliability), where reliability is the fraction of the amount that can be counted on in a bad month. This is a judgment per source, not a measured distribution.",
    status: "convention",
    usedBy: ["reliableIncomeFloor", "floorRatio"],
  },
  {
    id: "A2",
    title: "Buffer months use essential expenses only",
    statement:
      "Buffer months = liquid reserves / essential monthly expenses. Discretionary spending is assumed to be cut first in a crisis.",
    status: "convention",
    usedBy: ["bufferMonths"],
  },
  {
    id: "A3",
    title: "Income concentration via HHI",
    statement:
      "H = sum of squared income shares. 1 = a single source, 1/n = n equal sources. Shares use gross monthly amounts.",
    status: "convention",
    usedBy: ["incomeConcentration"],
  },
  {
    id: "A4",
    title: "Failure correlation as largest correlated block",
    statement:
      "Sources sharing a correlation group are assumed to fail together. Failure correlation = the largest share of income held by one group.",
    status: "convention",
    usedBy: ["failureCorrelation"],
  },
  {
    id: "A5",
    title: "Share-weighted volatility and replacement latency",
    statement:
      "Household income volatility and replacement latency are income-share-weighted means of the per-source values.",
    status: "convention",
    usedBy: ["incomeVolatility", "replacementLatency"],
  },
  {
    id: "A6",
    title: "Career-capital step model",
    statement:
      "C(t+1) = C(t) + effortToCapitalRate x qualityOfEffort x protectedHours x persistence - switchingCost. Career capital is an index whose scale is set by the estimated effortToCapitalRate; only its direction and relative change are meaningful.",
    status: "hypothesis",
    usedBy: ["careerCapitalStep", "projectCareerCapital"],
  },
  {
    id: "A7",
    title: "Productive-capital step model",
    statement:
      "A(t+1) = A(t) + capitalConversionRate x max(0, income - expenses) + A(t) x monthlyReturnRate. Expenses include essential, discretionary and debt payments.",
    status: "hypothesis",
    usedBy: ["productiveCapitalStep", "projectProductiveCapital"],
  },
  {
    id: "A15",
    title: "Monthly hours conversion",
    statement: "Weekly hours are converted to monthly hours with a factor of 4.33.",
    status: "convention",
    usedBy: ["projectCareerCapital"],
  },
];
