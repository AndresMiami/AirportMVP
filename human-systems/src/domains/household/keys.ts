/**
 * Household domain keys. These are CONFIGURATION of the household domain,
 * not engine constants: engine modules never import this file.
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

/** Other keys the household signature and sample use. */
export const OTHER_KEYS = {
  financialPressure: "financial_pressure",
  planningHorizon: "planning_horizon",
  survivalWorkShare: "survival_work_share",
  singleVehicleDependency: "single_vehicle_dependency",
  vehicleRepairExposure: "vehicle_repair_exposure",
  availableNewHours: "available_new_hours",
  scheduleFlexibility: "schedule_flexibility",
  riskTolerance: "risk_tolerance",
  physicalCapacity: "physical_capacity",
  supportNetwork: "support_network",
  careLoad: "care_load",
  retrainingReadiness: "retraining_readiness",
} as const;

export const HOUSEHOLD_DOMAIN_ID = "household";
export const HOUSEHOLD_DOMAIN_VERSION = 1;
