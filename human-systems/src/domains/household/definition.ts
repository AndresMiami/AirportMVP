/**
 * The household domain, version 1: the first configuration of the Human
 * Systems engine. Nothing in the engine depends on this file.
 */
import type { DomainDefinition } from "@/model/domain";
import { HOUSEHOLD_AI_EXAMPLE, HOUSEHOLD_PROMPT_FRAGMENT } from "./ai-example";
import { HOUSEHOLD_ASSUMPTIONS } from "./assumptions";
import { HOUSEHOLD_CONSTRAINT_TEMPLATES } from "./constraint-templates";
import { HOUSEHOLD_CATEGORIES, HOUSEHOLD_EVALUATION_DIMENSIONS } from "./evaluation-dimensions";
import { HOUSEHOLD_DERIVED } from "./derived";
import { HOUSEHOLD_DOMAIN_ID, HOUSEHOLD_DOMAIN_VERSION } from "./keys";
import { HOUSEHOLD_PROJECTIONS } from "./projections";
import { HOUSEHOLD_SIGNATURE_V1 } from "./signature-v1";
import { HOUSEHOLD_VARIABLES } from "./variables";

export const HOUSEHOLD_EVENT_TYPES = [
  "job_lost",
  "job_started",
  "contract_lost",
  "contract_signed",
  "business_launched",
  "training_started",
  "training_completed",
  "credential_obtained",
  "regulatory_change",
  "major_expense",
  "health_limitation_discovered",
  "household_member_joined",
  "household_member_left",
  "intervention_attempted",
  "decision_made",
  "other",
];

export const HOUSEHOLD_DOMAIN: DomainDefinition = {
  id: HOUSEHOLD_DOMAIN_ID,
  version: HOUSEHOLD_DOMAIN_VERSION,
  name: "Personal / household",
  description:
    "Income, expenses, buffers, dependencies, career capital and agency for an individual or a household. The first configuration of the engine; its thresholds and formulas are conventions, not findings.",
  kinds: [
    { id: "individual", label: "One person" },
    { id: "household", label: "Household" },
  ],
  subjectLabel: "Person",
  categories: HOUSEHOLD_CATEGORIES,
  evaluationDimensions: HOUSEHOLD_EVALUATION_DIMENSIONS,
  assumptions: HOUSEHOLD_ASSUMPTIONS,
  promptFragment: { ...HOUSEHOLD_PROMPT_FRAGMENT, exampleAnalysis: HOUSEHOLD_AI_EXAMPLE },
  variables: HOUSEHOLD_VARIABLES,
  derived: HOUSEHOLD_DERIVED,
  projections: HOUSEHOLD_PROJECTIONS,
  signatureDefinition: HOUSEHOLD_SIGNATURE_V1,
  constraintTemplates: HOUSEHOLD_CONSTRAINT_TEMPLATES,
  eventTypes: HOUSEHOLD_EVENT_TYPES,
};
