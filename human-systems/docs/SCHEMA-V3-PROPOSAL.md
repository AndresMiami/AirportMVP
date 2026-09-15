# Schema v3 proposal — Human Systems engine (revision 2)

Status: PROPOSAL, revised after review. Nothing here is implemented.
Baseline: the green code at the "unknown is never zero; members are
archived" commit. Revision 2 incorporates the reviewer's corrections
(unassigned subjects, earlier domain registry, unclassified relationship
kind, structured time, dated targets, multidimensional physical fit,
versioned extension envelope, committed-floor lower bound, overlapping
exposures) and records the remaining disagreements at the end.

Governing principle (CLAUDE.md): the engine is the product; domains are
configurations; a person's growing history is an asset of the model.

Epistemic rules carried unchanged: observation ≠ interpretation; unknown ≠
zero; unknown subject ≠ household; unknown relationship type ≠ causal;
derived values are computed, never typed; every value has provenance and
confidence; state ≠ dynamics; hypotheses are never facts; snapshots are
immutable; no universal score; migration never creates a claim; the person
decides.

---

## 0. Migration order (revised)

| Step | Stored version | Scope | Lands |
|---|---|---|---|
| 3a | 3 | Subject attribution with an explicit UNASSIGNED state; minimal domain registry + `VariableRef` resolver (household definition moves to `src/domains/household/`); relationship `kind` incl. `unclassified` and `participatesInDynamics`; Event log with structured time; hypothesis falsification fields; versioned extension envelope type; gap-score removal; signature maturity flag | first |
| 3b | 4 | Dated values (`VariableValueEntry`) AND dated targets (`VariableTargetEntry`); `evaluateSystem(asOf)` with the documented limitation; model export/import | second |
| 3c | 5 | Evidence convergence: embedded evidence → observations; observation links to income sources and events | third |
| 3d | 6 | Income model (committed lower bound, reliability-weighted, typical, upside), `FailureExposure` many-to-many; richer domain definitions; signature definition v2 (per-subject dimensions); `business_opportunity` domain module with the pool fixture as test data | fourth |

Each step: its own migration function, its own tests, a stored backup of
the pre-migration record, and a green suite before the next begins.
Member archiving (reviewer item 6) and the unknown-is-not-zero audit
(item 1) are already done on the baseline, before 3a.

---

## A. Subject attribution (3a)

```
type SubjectId = string                         // a member id or the system id
Variable     += subjectId: SubjectId | null     // null = UNASSIGNED (not "household")
             += key: string                     // definition key, e.g. "career_capital"
IncomeSource += earnerId: SubjectId | null      // free-text earner kept as earnerLabel until 3d
Constraint   += subjectId: SubjectId | null
Hypothesis   += subjectId?: SubjectId | null
Action       += subjectId: SubjectId | null
StructuralSignature += subjectId: SubjectId     // computed for one subject; never null
```

Rules
- `null` means "not yet assigned". It is displayed as such, counted in
  the model-health card, and surfaced by the question engine ("whose
  variable is this?"). It is never rendered as the household.
- Migration (v2 → v3) assigns `subjectId` ONLY where the active domain
  definition declares the key `scope: "system"` (expenses, reserves, debt,
  income aggregates, the derived household metrics). Keys declared
  `scope: "member"` (career capital, agency, protected hours, physical
  capacity, schedule, preferences, risk tolerance) and every custom
  variable migrate with `subjectId = null` and a review flag. The sample
  fixture is re-authored by hand (fixture data, not migration logic).
- Resolution: a system-scope formula reads system-scope keys; a
  member-scope computation reads keys resolved for that member. Unassigned
  variables never feed a member-scope computation and never feed a
  system-scope formula unless their key is system-scope by definition.
  Nothing averages members into one value.
- Members are archived, never erased; ids are stable historical subject
  ids (already on the baseline).

## B. Minimal domain registry and `VariableRef` (3a)

```
src/domains/registry.ts
  DomainDefinition (minimal in 3a) {
    id, version, name, systemTypes,
    variables: VariableDefinition[]   // { key, name, unit, category, changeSpeed,
                                      //   scope: "system" | "member", targetMode,
                                      //   referenceRange?, question? }
    derived: string[]                 // formula ids from model/derived.ts
    signatureDefinitionId, signatureDefinitionVersion,
    constraintTemplates, eventTypes
  }
  getDomainDefinition(id, version)
  VariableRef = { key: string; subjectId: SubjectId | null }
  resolveVariable(evaluated, ref) -> Variable | undefined
src/domains/household/definition.ts   // household v1: today's STANDARD_INPUTS + derived list
src/domains/household/signature-v1.ts // moved from src/signatures/definitions
src/domains/household/constraint-templates.ts
SystemModel += domainDefinitionId, domainDefinitionVersion
```
- `INPUT_IDS` / `DERIVED_IDS` become household keys inside the household
  domain. Engine modules (`model/derived.ts` formulas, `scenarios/compare.ts`,
  `signatures/compute.ts`) receive keys through the active definition and
  resolve them with `VariableRef`; no engine module imports a household key
  constant. A layering test enforces that `src/{calculations,model,
  scenarios,signatures}` do not import from `src/domains/household`.
- The rich definition (formula declarations, exposure kinds, question
  banks, domain-specific derived metrics) matures in 3d.

## C. Relationship epistemic kind (3a)

```
Relationship += kind: "unclassified" | "causal_hypothesis" | "association" | "definitional" | "constraint"
             += participatesInDynamics: boolean   // explicit; see below
             += hypothesisId?: string
```
- Loops, propagation, influence and the dynamics signature use ONLY edges
  with `participatesInDynamics === true`. The invariant: `kind` is
  `causal_hypothesis` (any value allowed) or `definitional` (the person
  opted in); `unclassified`, `association` and `constraint` edges always
  carry `false` and cannot be switched on without reclassifying.
- Formula dependencies are already recorded in the derived registry
  (`inputVariables` / `inputDerived`); they are drawn in the map as a
  separate, muted dependency layer without needing a Relationship. A
  definitional Relationship is therefore optional and defaults to
  `participatesInDynamics: false`; the person enables it only when they
  judge the dependency to act as a mechanism in the feedback structure.
- Migration: `sourceType === "calculated"` → `definitional`,
  `participatesInDynamics: false`; every other edge → `unclassified`,
  `participatesInDynamics: false`, review flag. Migration itself makes no
  causal claim. Consequence: a migrated real system has NO loops until the
  person reviews its edges; the sample fixture opts its edges in
  explicitly (fixture authoring).
- Display: unclassified and association edges stay visible in the map in
  a distinct muted style with the label "not a causal claim".

## D. Time (3a events; 3b values and targets) — 3b SHIPPED

3b status (2026-09-15): shipped as schema v4. Field names as built:
`ValueEntry { id, value, range?, valid, validBasis: asserted|recorded,
observed?, recordedAt, sourceType, confidence, evidence, observationIds,
note, status: active|superseded|retracted, supersedesId?, retractedAt?,
retractReason? }`, `TargetEntry { id, desiredValue, targetMode, valid,
validBasis, recordedAt, note, status, supersedesId?, retractedAt?,
retractReason? }`; `Variable.values` / `Variable.targets`;
`evaluateSystem(model, { now, asOf, includeArchivedMembers })`; derived
shells; `ModelService.exportModel` / `importModel`. Deviations from the
text below: `validBasis` was added so a migrated or undated entry says it
is known from its recording instant and never earlier; income sources are
NOT dated (3d), so as-of evaluation reads today's sources and says so.

Structured temporal reference, used by events, observations and value
entries; the original wording is always preserved:
```
TemporalRef {
  kind: "instant" | "date" | "range" | "approx" | "unknown",
  start?: ISO string,          // instant/date/range/approx (approx = start of the period)
  end?: ISO string,            // range; approx = end of the period
  precision: "datetime" | "day" | "month" | "year" | "unspecified",
  text: string                 // the person's words, e.g. "spring 2022", "around March"
}
sortKey(ref) -> string | null                    // start ?? null
compare(a, b) -> "before" | "after" | "overlaps" | "not_orderable"
```
Value history (3b):
```
VariableValueEntry { id, variableId, value: number | null, valid: TemporalRef,
                     observed?: TemporalRef, recordedAt: ISO, sourceType, confidence,
                     observationIds: string[], note, range?: { low, high } }
VariableTargetEntry { id, variableId, desiredValue: number | null, targetMode,
                      valid: TemporalRef, recordedAt: ISO, note }
Variable.values: VariableValueEntry[]; Variable.targets: VariableTargetEntry[]
```
- `currentValue` / `desiredValue` are removed from storage and become
  views: the entry whose `valid` covers `asOf` (default now; latest start
  wins; `not_orderable` entries are excluded and flagged).
- `evaluateSystem(model, { asOf })` reconstructs VALUE and TARGET state
  as of a date under the CURRENT structural graph (relationships,
  constraints, hypotheses, definitions are not versioned). The immutable
  signature snapshot remains the authoritative record of what the system
  believed at a moment, structure included. Screens say which of the two
  they are showing.
- Five clocks, named on screen: occurred (events), observed / recorded
  (evidence), valid (values, targets), asOf + createdAt (snapshots), lag
  (relationships).

## E. Event / shock / intervention log (3a)

```
Event { id, kind: "shock" | "change" | "intervention" | "outcome" | "decision",
        type: string (domain vocabulary), title, description,
        occurred: TemporalRef, recordedAt: ISO, subjectId: SubjectId | null,
        sourceType, confidence, observationIds: string[],
        links: { variableIds, relationshipIds, hypothesisIds, actionIds, eventIds, incomeSourceIds },
        status?: "planned" | "in_progress" | "done" | "abandoned",          // interventions
        expected?: { variableId, direction: "up" | "down", by?: TemporalRef }[],
        outcomeEventIds?: string[] }
SystemModel += events: Event[]
```
- An event is a dated fact, never a numeric variable. "Did the trajectory
  change after X?" compares values/snapshots before and after
  `occurred` and reports movement with "after, not because of".

## F. Hypothesis falsification (3a)

```
Hypothesis += disconfirmingConditions: string[]
           += predictions: { statement, variableId?, expectedDirection?, by?: TemporalRef }[]
           += reviewLog: { at: ISO, status, note }[]
           += killCriteria?: { statement, metricKey?, comparator?, threshold?,
                              status: "open" | "triggered" | "cleared", observationIds }[]
```
- The engine evaluates kill criteria against values and reports
  triggered / cleared; it never changes a status. Acceptance without a
  disconfirming condition stays allowed and visibly empty.

## G. Evidence architecture (3c)

One provenance graph: Observation → value entry → derived metric →
signature dimension → hypothesis; observations also link to events,
constraints, relationships, income sources and actions. Embedded
`evidence[]` arrays are converted to observations with
`origin: "migrated_evidence"` and removed; value entries carry their own
provenance plus optional observation links (no observation is forced for
every typed number).

## H. Income model (3d)

```
IncomeSource { ..., earnerId, role: "floor" | "engine" | "both" | "unclassified",
               typicalMonthly, committedMinimum: number | null, badMonthEstimate: number | null,
               upsideMonthly?: number | null, reliability?, volatility,
               replacementLatency: Lag, transferability?, controllability?, growthPotential?,
               exposures: { exposureId, share: 0..1 }[] }   // shares are per exposure; they do NOT sum to 1 across exposures
FailureExposure { id, name, kind: vehicle | platform | customer | client | employer | industry
                  | location | license | program | health | other, description, subjectId?,
                  replacementLatency?: Lag, sourceType, confidence, observationIds }
```
Derived:
- `committedFloor` = `{ knownLowerBound, knownSources, unknownSources }`
  (a lower bound over sources with a known committed minimum, plus the
  count of unknowns; never a single complete number while any source is
  unknown)
- `reliabilityWeightedIncome` (today's "reliable floor", renamed),
  `typicalIncome`, `upsideIncome`; `badMonthCoverage` and
  `committedFloorRatio` (the latter reported as a lower bound)
- per exposure: income at risk = Σ typical × share; `largestExposureShare`;
  `worstCredibleSharedFailureLatency`; `weightedReplacementLatency`;
  `largestSourceReplacementLatency`. Overlapping exposures are expected;
  no risk number is a sum across exposures.

## I. Structural signatures (3a flag; 3d definition v2)

`SignatureDefinition += maturity: "experimental" | "reviewed"`; household
v1 is experimental and says so on screen. Dimension definitions gain
`subjectScope`; `computeSignature(evaluated, { subjectId })`. Continuous
canonical, strip secondary, unknown ≠ zero, immutable snapshots, no
universal score. No UI polish until 3b lands.

## J. Extension envelope (3a type; used by 3d)

```
Action += extensions?: Record<string, { schemaVersion: number; payload: unknown }>
```
The core validates only the envelope, preserves unknown domains verbatim
through every migration, and never interprets a payload. A domain module
validates and migrates its own payload by `schemaVersion`.

## K. OpportunityProfile (3d, `src/domains/business-opportunity/`)

```
payload (schemaVersion 1) {
  facts: {                                   // each { value, sourceType, confidence, observationIds }
    founderProductionHoursPerWeekBeforeDelegation, delegationThresholdAccounts,
    requiredCompetence: string[], startupCapital: { low, high },
    paidLaborContributionMargin: { low, high }, salesCycle: { low: Lag, high: Lag },
    customerConcentrationByStage: { stage, hhi }[], routeDensityDependence,
    contractRecurrenceLevel, regulatoryMoat, buyerReachability,
    timeToFirstRevenue: { low: Lag, high: Lag }
  },
  physicalRequirements: {                    // 0..1 each, unknown allowed; NEVER collapsed into one scalar for matching
    lifting, heatExposure, standingWalking, ladderHeight, nightWork,
    chemicalExposure, repetitiveMotion, drivingHours
  },
  keyUnknowns: { question, variableKey?, status: "open" | "answered" }[],
  killCriteria: { statement, metricKey?, comparator?, threshold?, status, observationIds }[]
}
```
- `operatorFirstClass` (A–D) is DERIVED by the module from founder hours,
  delegation threshold, margin and required competence, shown as a summary
  with its rule visible; it is never stored as a fact.
- A summary `physicalDemand` may be displayed as a heuristic only; the
  bridge maps each physical dimension to `Action.requirements`
  (`lifting`, `heatExposure`, ...) so the generic feasibility check matches
  them against the person's constraints one by one.
- Pools, HVAC filters and micro-services are three Actions with payloads
  in test fixtures; nothing pool-specific enters the engine.

## L. Pool-validation experiment as entities

Unchanged from revision 1 (table in the previous version, now with
`occurred: TemporalRef` on events and physical requirements per
dimension): hypothesis with the seven kill criteria as disconfirming
conditions → founder-scoped constraints (per physical dimension) →
unknown variables → intervention events → verbatim observations → dated
value entries → criteria triggered/cleared → review-log status → decision
event → "first account signed" change event → income source with
exposures → Σ(t1) vs Σ(t2) with the events in between listed.

## M. Invariants and the tests that pin them

FOUNDATION (added 2026-09-14): every remaining stage (3b dated values and
targets, 3c evidence convergence, 3d income refinement and the
OpportunityProfile) is additionally bound by docs/FOUNDATIONS.md, Part E
(measurement boundary) and Part F (constitution): no new numeric field for
human meaning; qualitative statements enter as text with subject and
provenance; interpretations never auto-promote to facts; no universal
score; no optimisation target other than the person's own; inferred and
entered information stay distinguishable; nothing repurposed silently.
Section K's `physicalRequirements` and `facts` are class 1 (measurable /
estimable) and stay per-dimension, never collapsed; `keyUnknowns` and
`killCriteria` are class 2 (interpretive) with observation links.

Cross-cutting (tests/architecture, tests/calculations/unknown-not-zero, new tests/invariants):
1. UNKNOWN ≠ ZERO: every derived formula, projection, dimension and
   aggregate returns null / unknown when a required input is null; no
   `?? 0` on a data value anywhere in `src/{calculations,model,scenarios,
   signatures,domains}` (a lint-style test greps for it and allows only
   accumulator initialisers on an explicit allowlist).
2. UNKNOWN SUBJECT ≠ HOUSEHOLD: a migrated member-scope or custom variable
   has `subjectId === null`; system-scope keys get the system id; no
   member-scope computation reads an unassigned variable.
3. UNKNOWN KIND ≠ CAUSAL: a migrated non-calculated edge is `unclassified`
   with `participatesInDynamics === false`; loops over a migrated real
   model are empty until edges are reviewed; setting
   `participatesInDynamics: true` on an unclassified/association/constraint
   edge is refused by the mutation.
4. MIGRATION CREATES NO CLAIM: v2 → v3 of the sample produces no loops, no
   assigned member-scope subjects, no accepted hypotheses beyond those
   already recorded; migration is idempotent; the backup record equals the
   input byte for byte; a validation failure leaves storage untouched.
5. ENGINE ≠ DOMAIN: no import from `src/domains/household` inside engine
   directories; the engine evaluates a second, minimal test domain
   definition with different keys without code changes.
6. HISTORY IS AN ASSET: archived members keep their id and references;
   `removeMember` is refused while referenced (on baseline); value/target
   entries are append-only through mutations (edits create a new entry;
   a correction marks the old one superseded, never deletes); events are
   never deleted by cascades, only unlinked.
7. TIME: `compare(TemporalRef)` matrix (instant/date/range/approx/unknown ×
   same) yields before/after/overlaps/not_orderable exactly as specified;
   original text is preserved through parse/serialize; as-of resolution
   picks the covering entry and excludes not-orderable ones with a flag.
8. AS-OF SCOPE: `evaluateSystem(asOf)` reproduces values and targets of a
   past date; a later relationship change alters loops for that as-of
   evaluation (documented limitation) while the stored snapshot from that
   date does not change.
9. INCOME: committed floor with one unknown source reports
   `{ knownLowerBound, unknownSources: 1 }` and no total; exposure shares
   across exposures may exceed 1 in sum and the per-exposure income-at-risk
   figures are independent; renaming keeps HHI identical.
10. EXTENSIONS: an unknown domain envelope survives every migration and a
    save/reload byte for byte; a payload with a wrong `schemaVersion` is
    rejected by its module and preserved by the core.
11. OPPORTUNITY: a founder constraint on one physical dimension (e.g.
    `heatExposure ≤ 0.3`) makes an action with `heatExposure 0.7`
    infeasible while an action with `lifting 0.7` and low heat stays
    feasible; `operatorFirstClass` changes when founder hours change and is
    absent from the stored payload.
12. NO UNIVERSAL SCORE: `meanNormalizedGap` does not exist in code; the
    scenario and dashboard screens render counts and vectors only (source
    grep test).

## Q. Decision / experiment seam (FOUNDATIONS Part G; future, not scheduled)

No decision engine is built. This section records how each concept in
Part G maps onto the schema TODAY and the smallest seam to preserve, so
3b–3d do not close a door. Representation follows the evidence class:
exact number, range, ordinal judgment, or text; nothing here becomes one
score.

| Concept | Today | Smallest future seam |
|---|---|---|
| Decision | `Event.kind = "decision"` with `occurred`, subject, observations, links | keep; a decision links the hypotheses/assumptions it rested on (`links.hypothesisIds` exists) |
| Experiment / intervention | `Event.kind = "intervention"` with `status`, `expected[]`, `outcomeEventIds` | keep; an experiment is an intervention whose `expected` names the unknown it tests; no new entity |
| Hypothesis | `Hypothesis` with predictions, disconfirming conditions, review log, kill criteria | keep |
| Assumption | a `Hypothesis` of kind `general` today | a future `kind: "assumption"` value plus `dependsOnVariableIds` (which numbers it rests on) — an enum extension, no migration of meaning |
| Unknown / question | domain `question` per variable; AI `questions_to_reduce_uncertainty` (qualitative gain) | a future `Unknown` entity `{question, subjectId, status open/answered, observationIds, variableKey?}`; until then observations with a "question" marker are enough |
| Expected signal | `Event.expected[]` (variable, direction, by) and `Hypothesis.predictions[]` | keep both; do not add magnitudes unless a range with evidence |
| Observed outcome | `Event.kind = "outcome"` and `outcomeEventIds` | keep; the comparison expected-vs-observed is about the HYPOTHESIS, never about decision quality |
| Kill / reconsideration criterion | `KillCriterion` (engine reads, person sets status) | keep |
| Reversibility | `utility.reversibility` -1..1 today (a collapsed judgment) | future ordinal `reversible / costly_to_reverse / irreversible` inside a bet profile, never a decimal |
| Resources at risk | `Action.cost` 0..1 today | future `capitalAtRisk` as a money range (class 1) and `timeAtRisk` as a Lag; both inspectable |
| Time until evidence | none | future Lag range on the intervention: `evidenceExpectedWithin` |
| Recovery requirement | none | future text + links to the constraints/buffers it would consume (class 3 or class 1 per field) |
| Linked human constraints | `Action.requirements` vs `Constraint` dimensions; `links.constraintIds` on observations | keep; a decision event may link constraints |
| Linked human values | Observation (verbatim) or hard Constraint without `check` | keep as the only representation (Part E.2); never a weight |
| Alternative paths preserved | none | future `preservesActionIds[]` / `foreclosesActionIds[]` on an action or decision event; qualitative |
| Retrospective review | `Hypothesis.reviewLog` | future person-authored `DecisionReview {decisionEventId, category (the four of G.9), note, observationIds, at}`; never computed |
| Uncertainty level | numeric `confidence` everywhere | future qualitative enum `relatively_known / partially_known / highly_uncertain / unresolved` as an alternative representation; not a replacement migration |

Where these would live: a versioned `Action.extensions["bet-profile"]`
envelope (section J) for the per-option dimensions, and the event /
hypothesis entities for the rest. Nothing enters the universal engine
that assumes a business; the commercial-pool validation stays fixture
data (section L), and its logic — large commitment → identify assumptions
→ low-cost test → evidence → updated belief → decide on the larger
commitment — is the worked example of G.6, not engine code.

Postponed with it: any ranking that reads the bet profile, any
"expected value" arithmetic, any automatic experiment generator, any
probability field.

## N. Migration risks (revised)

As in revision 1, plus: (a) migrated systems lose all loops until edges
are reviewed, which must be explained on the feedback-map screen with a
one-click review queue; (b) unassigned subjects will be numerous for a
household that entered person-level variables; the review queue and the
question engine must make assignment cheap; (c) `TemporalRef` parsing of
existing `dateOrPeriod` free text is best-effort with `precision:
"unspecified"` and the text preserved, never a guessed date; (d) dated
targets double the value-history surface; the two histories share one
mutation path and one test harness.

## O. Postponed (unchanged)

Bayesian updating and calibration; estimate calculus (J stays a seam);
simulation and forecasting; interpretation layers; real AI; multi-user;
cloud; auth; payments; organizations; countries; full opportunity UI;
per-member signature screens before 3b; utility-dimension redesign;
renaming the attractor screens.

## P. Disagreements and refinements (revision 2)

1. Definitional edges default to `participatesInDynamics: false`, which
   removes the sample's balancing loop after a v2 → v3 migration of real
   data; the fixture opts in by authoring. I accept this: migration must
   not assert that a formula dependency acts as a mechanism.
2. Migrated real systems will show zero loops until reviewed. This is the
   honest outcome; the cost is a review queue, which 3a must ship with.
3. `TemporalRef` keeps the original text mandatory; parsing is assistive
   and never silently replaces it.
4. Committed floor as a lower bound with an unknown count is right; I
   would additionally forbid any screen from printing the lower bound
   without the unknown count beside it (pinned by test 9).
5. Dated targets are included in 3b rather than an event log of target
   changes; target-change events may still be logged for the timeline but
   are not the source of truth.
6. Kill-criteria thresholds and disconfirming conditions remain the
   person's parameters with provenance; the domain module ships none.
