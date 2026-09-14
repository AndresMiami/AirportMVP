/**
 * Well-known variable ids. Input ids are the values a person enters;
 * derived ids are recomputed by model/derived.ts. Other variables may use
 * any id; these are only the ones the household formulas depend on.
 */
export const INPUT_IDS = {
  essentialExpenses: "essential_expenses",
  discretionaryExpenses: "discretionary_expenses",
  liquidReserves: "liquid_reserves",
  totalDebt: "total_debt",
  monthlyDebtPayments: "monthly_debt_payments",
  careerCapital: "career_capital",
  productiveAssets: "productive_assets",
  capitalConversionRate: "capital_conversion_rate",
  protectedHours: "protected_hours",
  majorPaths: "major_paths",
  switchingFrequency: "switching_frequency",
  qualityOfEffort: "quality_of_effort",
  persistence: "persistence",
  switchingCost: "switching_cost",
  effortToCapitalRate: "effort_to_capital_rate",
  annualReturnRate: "annual_return_rate",
} as const;

export const DERIVED_IDS = {
  totalIncome: "total_income",
  reliableFloor: "reliable_floor",
  monthlySurplus: "monthly_surplus",
  floorRatio: "floor_ratio",
  bufferMonths: "buffer_months",
  incomeConcentration: "income_concentration",
  incomeVolatility: "income_volatility",
  failureCorrelation: "failure_correlation",
  replacementLatency: "replacement_latency",
  debtBurden: "debt_burden",
} as const;

export type DerivedId = (typeof DERIVED_IDS)[keyof typeof DERIVED_IDS];
