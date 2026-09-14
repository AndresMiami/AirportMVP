# Schema v3 proposal — Human Systems engine

Status: PROPOSAL. Nothing in this document is implemented. Written after the
green baseline (commit 0cf9050) for review before any schema work starts.

Governing principle (CLAUDE.md): the engine is the product; domains are
configurations; a person's growing history is an asset of the model.

Epistemic rules carried unchanged: observation ≠ interpretation; unknown ≠
zero; derived values are computed, never typed; every value has provenance
and confidence; state ≠ dynamics; hypotheses are never facts; snapshots are
immutable; no universal score; the person decides.

---

## 0. Recommendation on shape: four staged migrations, not one rewrite

"Schema v3" as a single step would touch every collection at once
(variables, income, relationships, constraints, evidence, events,
signatures). One migration of that size cannot be tested or rolled back
honestly. Proposal: keep the v3 *design* as one document, but ship it as
four numbered migrations, each green on its own and each shippable:

| Step | Version | Scope | Why first |
|---|---|---|---|
| 3a | 3 | Subject attribution (A), relationship epistemic kind (E), event/intervention log (C), hypothesis falsification fields (F), gap-score removal (H), signature maturity flag (I) | Additive, low risk; unlocks the pool experiment record immediately |
| 3b | 4 | Dated values (B) with as-of evaluation; target-change events | Changes the meaning of "current value"; needs its own tests |
| 3c | 5 | Evidence convergence (G): embedded evidence → observations; income-source and event links | Data-shape migration with generated ids |
| 3d | 6 | Income model refinement (D): committed minimum / reliability-weighted income / exposures; domain-definition registry formalised | Renames a derived metric and changes formulas; touches signature definition v2 |

The rest of this document describes the target state; each section names
the step it lands in.

---

## A. Person / household attribution (3a)

```
type SubjectId = string            // a member id, or the system id
Member { id, label, role, ... }     // unchanged

Variable   += subjectId: SubjectId           // default: system id
           += key: string                    // definition key, e.g. "career_capital"
                                             // id stays globally unique: "career_capital@m1"
IncomeSource += earnerId: SubjectId | null   // replaces free-text earner (kept as earnerLabel until 3d)
Constraint   += subjectId: SubjectId
Hypothesis   += subjectId?: SubjectId
Action       += subjectId: SubjectId         // who would carry it out
StructuralSignature += subjectId: SubjectId  // Σ(person) and Σ(household)
```

Rules:
- Person-scoped variables (career capital, physical capacity, agency,
  focus, schedule, preferences, risk tolerance) carry a member id. Household
  quantities (expenses, reserves, income aggregates) carry the system id.
- Derived formulas and signature dimensions reference variables by `key`
  and are resolved within a subject scope. A member-scope dimension reads
  `career_capital` for that member; a system-scope dimension reads the
  household key. No formula ever averages members into one value.
- Migration: every existing variable gets `subjectId = system id`,
  `key = id`. Sample fixture: the person-scoped variables are re-attributed
  to the member they describe (Dani / Marisol) by hand in the fixture.

## B. Time and dated values (3b)

```
VariableValueEntry {
  id, variableId,
  value: number | null,          // null = recorded as unknown at that time
  validFrom: ISO date,           // when the value started to hold
  validTo?: ISO date,            // when it stopped (open-ended if absent)
  observedAt?: ISO date,         // when it was observed
  recordedAt: ISO timestamp,     // when it was entered
  sourceType, confidence,
  observationIds: string[],      // evidence (see G)
  note: string,
  range?: { low: number; high: number }   // seam for J; not used in arithmetic yet
}
Variable.values: VariableValueEntry[]      // replaces currentValue
Variable.currentValue                      // REMOVED from storage; a view = latest entry with validFrom <= asOf
```

- `evaluateSystem(model, { asOf })` resolves each variable to the entry in
  force at `asOf`. Snapshots record `asOf` alongside `createdAt`. A
  signature can then be recomputed for a past date from stored history,
  and a stored snapshot remains the immutable record of what the model
  said at the time (judgments and edges included).
- Five clocks, kept distinct and displayed by name: occurredAt (events),
  observedAt / recordedAt (evidence), validFrom/validTo (values), asOf +
  createdAt (snapshots), lag (relationships).
- Target changes: editing a desired value or target mode logs a `change`
  event ("target changed"), so "what changed" never confuses a moved goal
  with a moved state.
- Migration: `currentValue` → one entry {validFrom = model.createdAt ??
  updatedAt, recordedAt = updatedAt, sourceType, confidence, note ""};
  embedded evidence becomes observationIds in 3c.
- Phase-0 residual this fixes: a standard input added with no value and
  then edited inline keeps confidence 0 / provenance unknown; with value
  entries every entered number carries its own provenance.

## C. Event / shock / intervention log (3a)

```
Event {
  id, kind: "shock" | "change" | "intervention" | "outcome" | "decision",
  type: string,                  // domain vocabulary: job_lost, contract_lost, new_job,
                                 // business_launched, training_started, regulatory_change,
                                 // major_expense, health_limitation_discovered, account_signed, ...
  title, description,
  occurredAt: string,            // date or period, as entered
  recordedAt: ISO timestamp,
  subjectId: SubjectId,
  sourceType, confidence, observationIds: string[],
  links: { variableIds, relationshipIds, hypothesisIds, actionIds, eventIds, incomeSourceIds },
  // interventions only
  status?: "planned" | "in_progress" | "done" | "abandoned",
  expected?: { variableId: string; direction: "up" | "down"; byWhen?: string }[],
  outcomeEventIds?: string[]
}
SystemModel += events: Event[]
```

- An event is a dated fact, never a numeric variable. A shock can be
  linked to the variables it hit; an intervention says what it was meant to
  move; an outcome event closes the loop.
- Timeline screen; snapshot comparison lists the events between the two
  snapshots; "did the trajectory change after X?" = the movement of the
  expected variables before vs after `occurredAt`, reported as observed
  movement with the language "after, not because of".

## D. Income model refinement (3d)

Terminology: stop calling `sum(amount × reliability)` a floor.

```
IncomeSource {
  id, name, earnerId, role: "floor" | "engine" | "both" | "unclassified",
  typicalMonthly: number,                    // was monthlyAmount
  committedMinimum: number | null,           // contractual/guaranteed part; null = unknown
  badMonthEstimate: number | null,           // explicit, or derived typical × reliability when only reliability is known
  upsideMonthly?: number | null,
  reliability?: number,                      // kept as the judgment behind badMonthEstimate
  volatility, replacementLatency: Lag,       // Lag with unit, not a bare months number
  transferability?, controllability?, growthPotential?: 0..1 judgments (optional)
  exposures: { exposureId: string; share: 0..1 }[]
}
FailureExposure {
  id, name, kind: "vehicle" | "platform" | "customer" | "client" | "employer" | "industry"
               | "location" | "license" | "program" | "health" | "other",
  description, subjectId?, replacementLatency?: Lag, sourceType, confidence, observationIds
}
SystemModel += exposures: FailureExposure[]
```

Derived (household level):
- `committedFloor` = Σ committedMinimum (unknown if any source is unknown → shown as a lower bound over known sources, labelled)
- `reliabilityWeightedIncome` = Σ badMonthEstimate (today's "reliable floor", renamed)
- `typicalIncome`, `upsideIncome`
- `committedFloorRatio` = committedFloor / essentials; `badMonthCoverage` = reliabilityWeightedIncome / essentials
- Concentration: HHI over typical income (kept)
- Exposure analysis per exposure: income at risk = Σ typical × share;
  `largestExposureShare` (replaces failureCorrelation),
  `worstCredibleSharedFailureLatency` = replacement latency of the exposure with the most income at risk,
  `weightedReplacementLatency` (kept), `largestSourceReplacementLatency` (kept)
- Nothing collapses into one risk number; the screen shows the exposure table.
- Migration: correlationGroup → one exposure of kind "other" named after the
  group with share 1; monthlyAmount → typicalMonthly; committedMinimum =
  null (unknown, never 0); badMonthEstimate = typical × reliability.

## E. Relationship epistemic kind (3a)

```
Relationship += kind: "causal_hypothesis" | "association" | "definitional" | "constraint"
             += hypothesisId?: string
```
- Loops and propagation use `causal_hypothesis` and `definitional` edges only
  (definitional edges are true by formula, e.g. reserves → buffer months).
  `association` and `constraint` edges are drawn distinctly, excluded from
  loops, propagation, influence and the dynamics signature, and labelled
  "association, not a causal claim".
- Migration: sourceType "calculated" → definitional; everything else →
  causal_hypothesis with a review flag in the editor ("kind assigned by
  migration; confirm").

## F. Hypothesis falsification (3a)

```
Hypothesis += disconfirmingConditions: string[]     // what evidence would weaken or change it
           += predictions: { statement, variableId?, expectedDirection?, byWhen? }[]
           += reviewLog: { at, status, note }[]      // every status change, with reason
           += killCriteria?: { statement, metricKey?, threshold?, status: "open" | "triggered" | "cleared", observationIds }[]
```
- The screen shows an empty-state prompt for disconfirming conditions on
  every accepted hypothesis; acceptance is still allowed without one, but
  the absence is visible.
- Kill criteria are the person's own decision rules with provenance; the
  engine only reports "metric vs threshold: triggered / not triggered" and
  never changes a status by itself.

## G. Evidence architecture (3c)

One provenance graph:
```
Observation (the only evidence record)
  → VariableValueEntry.observationIds
  → derived metric (formula inputs)
  → StructuralDimensionSnapshot.contributions[].observationIds
  → Hypothesis.supporting / contradicting
  → Event.observationIds, Constraint.observationIds, Relationship.observationIds,
    IncomeSource.observationIds, Action.observationIds
```
- Embedded `evidence: Evidence[]` arrays are removed from every entity.
  Migration converts each embedded item into an Observation
  `{ statement: text, sourceType, dateOrPeriod: recordedAt ?? "", origin: "migrated_evidence" }`
  and links it. Observations gain `origin: "entered" | "migrated_evidence" | "ai_proposed"`.
- Observation links gain `incomeSourceIds` and `eventIds`.

## H. Universal gap score removal (3a)

- `GapSummary.meanNormalizedGap` deleted; dashboard and scenario screens
  show open/closed counts, the per-variable list, the per-dimension gap
  vector with worded bands, and (scenarios) counts of gaps that shrink or
  grow. Tests updated. No percentage that reads as "distance from the ideal life".

## I. Structural signatures (3a flag; per-subject in 3b+)

- `SignatureDefinition += maturity: "experimental" | "reviewed"`;
  `HOUSEHOLD_SIGNATURE_V1.maturity = "experimental"`, shown on every
  signature screen next to the thresholds ("conventions, not validated").
- Dimension definitions gain `subjectScope: "system" | "member"`;
  `computeSignature(evaluated, { subjectId })`. Member dimensions read that
  member's variables; system dimensions read household keys.
- Continuous canonical, strip secondary and expandable, unknown ≠ zero,
  immutable snapshots: unchanged. Comparing snapshots produced by different
  definition versions is allowed only with a visible warning.
- No signature UI polish until 3b lands.

## J. Estimate seam (design only)

```
ValueEstimate = { kind: "exact", value }
              | { kind: "range", low, high, mode? }
              | { kind: "ordinal", scaleId, level }
              | { kind: "unknown" }
```
- 3b adds only `range?` on value entries (stored, displayed, not used in
  arithmetic). The engine keeps `value: number | null` until an estimate
  calculus is designed. Interface: anchored confidence words
  (e.g. "documented" / "reported" / "estimated" / "guessed") shown beside
  every number, stored as the existing 0..1.

## K. Domain definitions (formalised in 3d, seeded now)

```
DomainDefinition {
  id, version, name, systemTypes,
  variableDefinitions: StandardInputDefinition[] + subjectScope + questions,
  derivedDefinitions: (formula ids, from model/derived.ts),
  signatureDefinition: SignatureDefinition,
  eventTypes: string[],
  constraintTemplates,
  exposureKinds
}
SystemModel += domainDefinitionId + domainDefinitionVersion
```
- `src/model/standard-inputs.ts` (added in Phase 0) is the seed of the
  household definition's variable list. Engine modules must stop importing
  `INPUT_IDS` directly once the registry exists; they resolve keys through
  the active definition.

---

## L. OpportunityProfile (domain extension, designed now, minimal implementation later)

Lives in `src/domains/business-opportunity/`, never in the universal types.
The universal `Action` gets one generic slot:

```
Action += extensions?: Record<domainId, unknown>   // validated by the domain module's schema
```

```
OpportunityProfile {                       // extensions["business_opportunity"]
  version: 1,
  attributes: {                            // every attribute is { value, sourceType, confidence, observationIds }
    operatorFirstClass: "A" | "B" | "C" | "D" | null,
    founderProductionHoursPerWeekBeforeDelegation: number | null,
    delegationThresholdAccounts: number | null,
    startupCapital: { low, high } | null,
    paidLaborContributionMargin: { low, high } | null,
    salesCycle: { low: Lag, high: Lag } | null,
    customerConcentrationByStage: { stage: string; hhi: number }[],
    routeDensityDependence: 0..1 | null,
    contractRecurrenceLevel: "none" | "monthly" | "annual" | "multi_year" | null,
    regulatoryMoat: 0..1 | null,
    physicalDemand: 0..1 | null,
    buyerReachability: 0..1 | null,
    timeToFirstRevenue: { low: Lag, high: Lag } | null
  },
  keyUnknowns: { question, variableKey?, status: "open" | "answered" }[],
  killCriteria: { statement, metricKey?, comparator?, threshold?, status, observationIds }[]
}
```

Bridge to the engine (the only coupling):
- The module derives `Action.requirements` from the profile:
  `hoursPerWeek` ← founder production hours, `capitalRequired` ← startupCapital.high,
  `physicalDemand` ← physicalDemand, `requiresLicense` ← regulatory attributes,
  `timeToFirstRevenueMonths` ← lag. The existing `checkFeasibility` then
  discovers conflicts against the founder's constraints exactly as it does
  today (a constraint `physicalDemand ≤ 0.3` on the founder vs an
  opportunity `physicalDemand 0.7` is a hard violation; "must not depend on
  recurring field labor" vs `founderProductionHours 30` is another).
- `keyUnknowns` feed the question-priority list; `killCriteria` are
  evaluated against dated values by the engine as "triggered / not
  triggered" only.
- Commercial pools, HVAC filters and property micro-services are three
  Actions with profiles, i.e. test data for the module, never defaults.

---

## M. The pool-validation experiment, as model entities

| Theory item | Entity | Content |
|---|---|---|
| Hypothesis | Hypothesis H1 (kind general, subject founder) | "Commercial/HOA pool maintenance, operator-first with a hired CPO technician, could add diversified recurring income." status proposed; disconfirmingConditions = the seven kill criteria; predictions: ≥5 walkthroughs and ≥2 serious quote requests from 40–50 contacts within 60–90 days |
| Alternatives | H2 property micro-services (fallback), H3 documented HVAC filter/consumables service | separate hypotheses so one rejection never hides another |
| Constraints | founder-scoped: physicalDemand ≤ 0.3 (hard; evidence: the observation of dizziness during strenuous work, stated not diagnosed); "no dependence on recurring field labor" (hard); capital ≤ certification cost until tests pass (hard); "do not quit current income" (hard) | subjectId = founder |
| Opportunity | Action A1 "commercial pool service" + OpportunityProfile | class, founder hours, delegation threshold, capital range, margin range, sales cycle, concentration by stage, route density, recurrence, moat, physicalDemand, reachability, time to revenue; each with provenance from the research |
| Unknowns | variables (opportunity scope): `miami_commercial_account_price` (unknown), `cpo_labor_wage_available` (unknown), `hvac_filter_current_spend` (unknown); profile keyUnknowns | question priority surfaces them first |
| Interventions | Events kind intervention: assemble ~100 prospects; contact 40–50 buyers; obtain 3 competitor quotes; post/research CPO technicians; 10 HVAC-filter conversations | each with status, expected signals and linked hypothesis |
| Observations | as they happen: contacts, conversations, walkthroughs, quote requests, objections, incumbent satisfaction, contract structure, decision-maker identity; competitor quotes; technician responses and asked wages | verbatim, dated, linked to unknown variables and to H1 |
| New evidence → values | dated value entries: account price range, wage available, response rate | provenance = the observations |
| Kill criteria | evaluated on the profile: margin < 25% with clustering; no competent CPO near modeled wage; buyers locked to incumbents; insufficient response in 60–90 days; no clustering; founder field labor required; repair attach essential but uncapturable | engine reports triggered / cleared; the person decides |
| Updated hypothesis | H1 reviewLog entry: accepted / uncertain / rejected with reason | never automatic |
| Decision | Event kind decision: continue / modify / stop | linked to H1 |
| Event | "first account signed" (kind change) | occurredAt, linked to the new income source |
| Structural change | IncomeSource added: role engine, exposures {customer, license, route density}, committedMinimum from the contract | Σ(t2) snapshot |
| Later question | compare Σ(t1) vs Σ(t2): income concentration, buffer, planning horizon, productive capital; persistence indicators; events between the snapshots listed | "after, not because of" |

---

## N. Migration risks

1. Scope: v3 touches every collection; hence the four-step plan. Each step
   keeps a backup copy of the pre-migration record in storage
   (`store.backups[modelId][fromVersion]`) until the person deletes it.
2. Semantics: "reliable floor" is renamed and its formula split; stored
   snapshots keep their definition version and are compared across versions
   only with a warning. Signature definition becomes v2 in 3d.
3. Edge kinds: migrated edges default to causal_hypothesis; some are really
   associations. The editor flags them for review; loops may change once
   the person reclassifies.
4. Unknown committed minimum: every migrated system shows the committed
   floor as unknown until entered. Intended; must be explained on screen.
5. Generated observation ids from embedded evidence: collision-safe
   generation and a dedupe of identical texts on the same entity.
6. The sample fixture and ~190 tests reference `currentValue`,
   `monthlyAmount`, `correlationGroup`; each step rewrites the fixture and
   the affected tests. This is most of the cost.
7. History growth in localStorage is fine at this scale; a size guard and
   an export/import (JSON) belong in 3b so a history can be moved.
8. Subject re-attribution of the sample is manual and must not invent
   facts about the fictional people.

## O. Ideas that should remain postponed

- Bayesian updating, calibration of confidence, any estimate calculus (J stays a seam).
- Dynamic simulation, forecasting, projected curves beyond the boxed model-assumption panel.
- Traditional / practitioner interpretation layers (interface exists; no implementation).
- Real AI provider; multi-user; cloud; auth; payments; organizations; countries.
- Full OpportunityProfile UI: only the schema, the requirements bridge, and one test case (pools) in 3a/3d.
- Per-member signature screens until 3b (dated values) and A are in place.
- Redesign of the fourteen utility dimensions (make them per-person and configurable later).
- Renaming the attractor screens.

## P. Disagreements and refinements (author's view)

1. One "v3" is too big; ship four migrations (above). The design stays one document.
2. Evidence convergence should not require an Observation for every typed number. Value entries carry their own sourceType/confidence and optional observation links; embedded free-text evidence is what gets converted.
3. Terminology: only the committed minimum should ever be called a floor. The reliability-weighted sum is "reliability-weighted income" (not "bad-month expected income", which still sounds like a measurement).
4. Date the targets too, or at least log target changes as events in 3b; otherwise "what changed" mixes moved goals with moved states.
5. Definitional edges belong in loops (true by formula); associations and constraints do not.
6. Kill-criteria thresholds (25% margin, 60–90 days) are the founder's decision parameters and must be stored on the person's hypothesis with provenance, never as defaults in the domain module.
7. HVAC filters and micro-services are separate hypotheses, not sub-items of the pool hypothesis.
8. The engine reports "criterion triggered"; it never rejects a hypothesis. Rejection is a human review-log entry.
