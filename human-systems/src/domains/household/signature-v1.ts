/**
 * Default signature definition for the personal / household domain.
 * Every threshold and range here is a CONVENTION (assumption A19), kept as
 * data so a future domain can ship a different definition without
 * touching the engine. Dimension inputs refer to variable ids; an input
 * whose variable is absent or has no value is UNKNOWN, never zero (A20).
 */
import { SignatureDefinitionSchema, type SignatureDefinition } from "@/types/signature";
import { DERIVED_IDS, INPUT_IDS } from "./keys";

const D = DERIVED_IDS;
const I = INPUT_IDS;

export const HOUSEHOLD_SIGNATURE_V1: SignatureDefinition = SignatureDefinitionSchema.parse({
  id: "household_default",
  name: "Household structural signature",
  domainId: "household",
  version: 1,
  maturity: "experimental",
  description:
    "Ten dimensions of persistent structural position for a person or household. Each is a 0..1 normalisation of entered variables; thresholds are conventions, not findings.",
  dimensions: [
    {
      id: "income_floor",
      name: "Reliable income floor",
      explanation: "How far reliable income goes toward covering essential expenses in a bad month (floor ratio). 1.0 on the ratio maps to 0.67 here; strong means essentials are covered by reliable income alone.",
      inputs: [
        {
          variableKey: D.floorRatio,
          transform: { kind: "linear", min: 0, max: 1.5 },
          question: "In a bad month, which income can be counted on, and what are the essential expenses it must cover?",
        },
      ],
      binaryThreshold: 0.67,
      bandThresholds: [0.33, 0.5, 0.67, 0.83],
      importance: 0.9,
    },
    {
      id: "financial_buffer",
      name: "Financial buffer",
      explanation: "Months of essential expenses covered by liquid reserves. Six months maps to 1.0; three months is the strong threshold.",
      inputs: [
        {
          variableKey: D.bufferMonths,
          transform: { kind: "linear", min: 0, max: 6 },
          question: "How much money is available within days (checking, savings, cash), and what are the essential monthly expenses?",
        },
      ],
      binaryThreshold: 0.5,
      importance: 0.9,
    },
    {
      id: "income_resilience",
      name: "Income / dependency resilience",
      explanation: "How well income would survive the loss of one source: concentration, correlated failure, replacement latency, volatility, and single-point dependencies. Each input is inverted so a higher value means more resilient.",
      inputs: [
        { variableKey: D.incomeConcentration, transform: { kind: "linear", min: 0, max: 1 }, invert: true, question: "How is household income split between sources (approximate amounts per source)?" },
        { variableKey: D.failureCorrelation, transform: { kind: "linear", min: 0, max: 1 }, invert: true, question: "Which income sources would disappear together (same employer, platform, client, or local industry)?" },
        { variableKey: D.replacementLatency, transform: { kind: "linear", min: 0, max: 6 }, invert: true, question: "If the main income source ended, approximately how many weeks or months would it normally take to replace that income?" },
        { variableKey: D.incomeVolatility, transform: { kind: "linear", min: 0, max: 1 }, invert: true, question: "Over the last six months, what were the lowest and highest monthly amounts for each income source?" },
        { variableKey: "single_vehicle_dependency", transform: { kind: "linear", min: 0, max: 1 }, invert: true, weight: 0.5, question: "Do several incomes depend on one vehicle, one location, or one person's availability?" },
      ],
      minimumKnownInputs: 2,
      importance: 0.85,
    },
    {
      id: "career_capital",
      subjectScope: "member",
      name: "Career capital",
      explanation: "The 0-100 career-capital index (skills, credentials, reputation, relationships that raise reliable income over time). The index itself is a judgment; this dimension inherits its uncertainty.",
      inputs: [
        {
          variableKey: I.careerCapital,
          transform: { kind: "linear", min: 0, max: 100 },
          question: "Which credentials, skills or relationships currently raise the income the person can command, and which would a new employer or client pay a premium for?",
        },
      ],
      importance: 0.8,
    },
    {
      id: "productive_assets",
      name: "Productive assets",
      explanation: "Equipment or capital that earns or saves money, plus the share of surplus that becomes assets. $20,000 of productive assets maps to 1.0.",
      inputs: [
        { variableKey: I.productiveAssets, transform: { kind: "linear", min: 0, max: 20000 }, question: "What equipment, tools or capital currently earn or save money, and roughly what would they cost to replace?" },
        { variableKey: I.capitalConversionRate, transform: { kind: "linear", min: 0, max: 1 }, weight: 0.5, question: "In months with money left over, roughly what share was kept as savings or spent on something that earns?" },
      ],
      importance: 0.6,
    },
    {
      id: "focus_commitment",
      subjectScope: "member",
      name: "Focus / sustained commitment",
      explanation: "Whether effort stays on one path long enough to compound: number of simultaneous paths and switching frequency (inverted), persistence, protected hours and quality of effort.",
      inputs: [
        { variableKey: I.majorPaths, transform: { kind: "linear", min: 0, max: 4 }, invert: true, question: "How many major directions (jobs, courses, businesses) are being pursued at the same time right now?" },
        { variableKey: I.switchingFrequency, transform: { kind: "linear", min: 0, max: 4 }, invert: true, question: "In the last 24 months, how many times did the main path change?" },
        { variableKey: I.persistence, transform: { kind: "linear", min: 0, max: 1 }, question: "In the last 24 months, which career or business paths received at least 100 hours of sustained work?" },
        { variableKey: I.protectedHours, transform: { kind: "linear", min: 0, max: 15 }, question: "In a typical week, how many hours are reliably reserved for building skills rather than sold for immediate income?" },
        { variableKey: I.qualityOfEffort, transform: { kind: "linear", min: 0, max: 1 }, weight: 0.5, question: "During protected hours, how focused is the work (interruptions, clear goals, feedback)?" },
      ],
      minimumKnownInputs: 2,
      importance: 0.8,
    },
    {
      id: "physical_feasibility",
      subjectScope: "member",
      name: "Physical feasibility / capacity compatibility",
      explanation: "Whether the person's physical capacity and schedule can carry the kind of work the plan assumes. Physical capacity is required; without it the dimension is unknown.",
      inputs: [
        { variableKey: "physical_capacity", transform: { kind: "linear", min: 0, max: 1 }, required: true, question: "Are there physical limits (lifting, standing, driving hours, health conditions) that rule out or restrict certain kinds of work?" },
        { variableKey: "schedule_flexibility", transform: { kind: "linear", min: 0, max: 1 }, weight: 0.5, question: "How freely can working hours be moved (fixed shifts, school pickups, care duties)?" },
      ],
      importance: 0.6,
    },
    {
      id: "adaptive_capacity",
      subjectScope: "member",
      name: "Adaptive capacity",
      explanation: "Slack available to respond to change: hours free for anything new, schedule flexibility, and readiness to retrain.",
      inputs: [
        { variableKey: "available_new_hours", transform: { kind: "linear", min: 0, max: 20 }, question: "After work, commuting, care and sleep, how many hours a week are genuinely free for something new?" },
        { variableKey: "schedule_flexibility", transform: { kind: "linear", min: 0, max: 1 }, question: "How freely can working hours be moved (fixed shifts, school pickups, care duties)?" },
        { variableKey: "retraining_readiness", transform: { kind: "linear", min: 0, max: 1 }, weight: 0.5, question: "If the current work disappeared, what retraining or job change would the person actually be willing and able to take on within a year?" },
      ],
      minimumKnownInputs: 2,
      importance: 0.6,
    },
    {
      id: "social_support",
      name: "Social / support resilience",
      explanation: "People and arrangements that absorb shocks: who could help with money, childcare, housing or work leads, and how many people depend on the household.",
      inputs: [
        { variableKey: "support_network", transform: { kind: "linear", min: 0, max: 1 }, required: true, question: "If income stopped for two months, who could realistically help with money, housing, childcare or work leads?" },
        { variableKey: "care_load", transform: { kind: "linear", min: 0, max: 1 }, invert: true, weight: 0.5, question: "How many people depend on the household for care or money, and how many hours a week does that take?" },
      ],
      importance: 0.6,
    },
    {
      id: "planning_horizon",
      name: "Planning horizon / ability to act beyond survival",
      explanation: "How far ahead money decisions are actually made, and how much felt pressure is crowding out longer-term action. Twelve months maps to 1.0.",
      inputs: [
        { variableKey: "planning_horizon", transform: { kind: "linear", min: 0, max: 12 }, question: "When a money decision comes up, how far ahead is it actually planned: the next paycheck, the next few months, or the next year?" },
        { variableKey: "financial_pressure", transform: { kind: "linear", min: 0, max: 10 }, invert: true, weight: 0.5, question: "On a 0-10 scale, how much does money feel like a pressure right now, and what most recently drove it up or down?" },
      ],
      importance: 0.7,
    },
  ],
});

