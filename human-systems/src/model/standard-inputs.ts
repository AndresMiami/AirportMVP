/**
 * The household domain's STANDARD INPUT VARIABLES: the entered quantities
 * the derived formulas (model/derived.ts) and the compounding step models
 * read by id. A blank system can add any of them under its canonical id so
 * the calculated ratios find their inputs. Values start UNKNOWN (null,
 * confidence 0, provenance unknown): nothing here presumes a number.
 *
 * This is domain data (the household configuration), not engine logic.
 */
import type { ChangeSpeed, TargetMode, VariableCategory } from "@/types";
import { INPUT_IDS } from "./ids";

export interface StandardInputDefinition {
  id: string;
  name: string;
  description: string;
  unit: string;
  category: VariableCategory;
  changeSpeed: ChangeSpeed;
  targetMode: TargetMode;
  referenceRange?: { min: number; max: number };
}

export const STANDARD_INPUTS: StandardInputDefinition[] = [
  { id: INPUT_IDS.essentialExpenses, name: "Essential monthly expenses", description: "Rent, food, utilities, transport, insurance, childcare.", unit: "$/month", category: "structure", changeSpeed: "slow", targetMode: "at_most", referenceRange: { min: 0, max: 6000 } },
  { id: INPUT_IDS.discretionaryExpenses, name: "Discretionary monthly expenses", description: "Spending that could be cut first in a crisis.", unit: "$/month", category: "event", changeSpeed: "fast", targetMode: "at_most", referenceRange: { min: 0, max: 1500 } },
  { id: INPUT_IDS.liquidReserves, name: "Liquid reserves", description: "Cash and balances available within days.", unit: "$", category: "buffer", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 20000 } },
  { id: INPUT_IDS.totalDebt, name: "Total debt", description: "All outstanding balances.", unit: "$", category: "structure", changeSpeed: "slow", targetMode: "at_most", referenceRange: { min: 0, max: 20000 } },
  { id: INPUT_IDS.monthlyDebtPayments, name: "Monthly debt payments", description: "Minimum payments due each month.", unit: "$/month", category: "structure", changeSpeed: "slow", targetMode: "at_most", referenceRange: { min: 0, max: 1000 } },
  { id: INPUT_IDS.careerCapital, name: "Career capital (index)", description: "Skills, credentials, reputation and relationships that raise reliable income over time. An unscaled 0-100 judgment.", unit: "index 0-100", category: "asset", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 100 } },
  { id: INPUT_IDS.productiveAssets, name: "Productive assets", description: "Equipment or capital that earns or saves money.", unit: "$", category: "asset", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 10000 } },
  { id: INPUT_IDS.capitalConversionRate, name: "Capital conversion rate", description: "Share of surplus that becomes reserves or productive assets.", unit: "share 0-1", category: "agency", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 1 } },
  { id: INPUT_IDS.protectedHours, name: "Protected compounding hours", description: "Weekly hours reliably reserved for skill-building.", unit: "hours/week", category: "asset", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 20 } },
  { id: INPUT_IDS.majorPaths, name: "Simultaneous major paths", description: "Number of big directions pursued at once.", unit: "count", category: "agency", changeSpeed: "slow", targetMode: "at_most", referenceRange: { min: 0, max: 5 } },
  { id: INPUT_IDS.switchingFrequency, name: "Switching frequency", description: "How often the main path changes.", unit: "switches/year", category: "agency", changeSpeed: "slow", targetMode: "at_most", referenceRange: { min: 0, max: 4 } },
  { id: INPUT_IDS.qualityOfEffort, name: "Quality of effort", description: "How focused protected hours are (a self-rating).", unit: "index 0-1", category: "agency", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 1 } },
  { id: INPUT_IDS.persistence, name: "Persistence", description: "Tendency to keep going on a chosen path (a judgment, never inferred from one event).", unit: "index 0-1", category: "agency", changeSpeed: "slow", targetMode: "at_least", referenceRange: { min: 0, max: 1 } },
  { id: INPUT_IDS.switchingCost, name: "Switching cost", description: "Career-capital points lost per change of path (an estimate).", unit: "index points/switch", category: "structure", changeSpeed: "slow", targetMode: "exact", referenceRange: { min: 0, max: 20 } },
  { id: INPUT_IDS.effortToCapitalRate, name: "Effort-to-capital rate", description: "Index points gained per focused, persistent protected hour (sets the scale of the index; an estimate).", unit: "index points/hour", category: "structure", changeSpeed: "slow", targetMode: "exact", referenceRange: { min: 0, max: 0.5 } },
  { id: INPUT_IDS.annualReturnRate, name: "Return on existing capital", description: "Annual return assumed on productive assets (an estimate).", unit: "rate/year", category: "structure", changeSpeed: "slow", targetMode: "exact", referenceRange: { min: 0, max: 0.1 } },
];

export const STANDARD_INPUT_BY_ID: Record<string, StandardInputDefinition> = Object.fromEntries(
  STANDARD_INPUTS.map((d) => [d.id, d]),
);
