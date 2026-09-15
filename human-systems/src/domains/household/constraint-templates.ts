/** Household domain: quick-start constraint templates for the editor. */
import type { ConstraintTemplate } from "@/model/domain";

export const HOUSEHOLD_CONSTRAINT_TEMPLATES: ConstraintTemplate[] = [
  { id: "physical_limitation", label: "Physical limitation", name: "No sustained heavy lifting", description: "A physical demand the person cannot take on (as stated; not diagnosed here).", type: "hard", check: { dimension: "heavyLifting", comparator: "eq", limit: false } },
  { id: "available_hours", label: "Available hours", name: "Available hours per week", description: "Hours that can be committed each week after existing obligations.", type: "hard", check: { dimension: "hoursPerWeek", comparator: "lte", limit: null } },
  { id: "minimum_income", label: "Minimum required income", name: "Minimum required income", description: "An option has to bring in at least this much per month.", type: "hard", check: { dimension: "minimumMonthlyIncome", comparator: "gte", limit: null } },
  { id: "transportation", label: "Transportation requirement", name: "No driving required", description: "Options that depend on driving are not available (no vehicle, no licence, or the person does not drive).", type: "hard", check: { dimension: "requiresDriving", comparator: "eq", limit: false } },
  { id: "licensing", label: "Licensing requirement", name: "No licence held", description: "Options that need a licence or certification the person does not hold.", type: "hard", check: { dimension: "requiresLicense", comparator: "eq", limit: false } },
  { id: "startup_capital", label: "Startup capital limit", name: "Startup capital limit", description: "Upfront money that can be committed without consuming the reserve.", type: "hard", check: { dimension: "capitalRequired", comparator: "lte", limit: null } },
  { id: "location", label: "Location", name: "No relocation", description: "The household stays where it is; options that require moving are out.", type: "hard", check: { dimension: "requiresRelocation", comparator: "eq", limit: false } },
  { id: "family", label: "Family responsibility", name: "Family responsibility", description: "A recurring obligation the model cannot check yet; listed as unchecked for every action.", type: "hard" },
  { id: "risk_tolerance", label: "Risk tolerance", name: "Prefers predictable income", description: "Options with higher income risk are less suitable, not excluded.", type: "soft", check: { dimension: "riskLevel", comparator: "lte", limit: 0.4 }, softPenalty: 0.4 },
];
