# Editing contract (schema v5)

How UI screens change the model. Read this before writing an editor, and
read docs/FOUNDATIONS.md before this: every screen is bound by its
constitution (Part F) and the measurement boundary (Part E.2).

## Foundation rules every screen obeys

- Class 3 information (values, commitments, spiritual beliefs, intuitions,
  purposes) is entered as TEXT: an Observation, or a hard Constraint with
  no machine-checkable `check` (reported "unchecked", never scored). A
  screen never offers a slider, rating or number for meaning. If the
  person chooses a numeric convention for a limited purpose, the screen
  labels it as their chosen convention and keeps the statement beside it.
- An intuition is preserved verbatim as an observation. A screen may ask
  the follow-up questions in FOUNDATIONS E.3; it never labels the intuition
  irrational, correct, incorrect, a bias or a truth.
- Wording: describe conditions and positions of the situation, never the
  person. Allowed: structural signature, recurring pattern, observed
  tendency, working hypothesis, current state, persistent condition.
  Never: type, code, diagnosis, trait-as-verdict, identity, "you are".
- Every number about a person shows its provenance and its epistemic
  class; ranks and bands come before decimals; unknown stays visible.
- The only objective a screen optimises, ranks or sorts by is the
  person's own targets, constraints, weights and hypothesis status. No
  screen nudges toward engagement, retention, conversion or any third
  party's interest, and no screen manufactures urgency from the data.
- Source types are shown as PROVENANCE, never as truth: `ai_inferred`,
  `estimated`, `calculated`, `self_reported`, `measured`, `observed` and
  `unknown` are visually distinguishable everywhere a value is shown, and
  no screen labels a measured or observed value "fact" or a self-reported
  value "estimate" on the strength of its source type alone; confidence
  and evidence sit beside it.
- No screen prescribes. A screen may show what is known, assumed and
  unknown, what could happen if an option fails, how reversible it is,
  how long until evidence arrives, which smaller test could answer a
  question, and which values and constraints the person recorded. It
  never ends with "therefore do X", never marks an option as "the right
  choice", and never manufactures urgency. A conditional comparison
  ("given your stated goals and constraints, B is better supported on
  these dimensions") may appear only where the person explicitly asked
  for help choosing, with its reasons, assumptions and unknowns on the
  same screen (FOUNDATIONS G.13); it is analysis, never a verdict.
- Bet dimensions stay separate on screen (FOUNDATIONS G.4): no total that
  folds downside, reversibility, capital or time at risk, time until
  evidence and upside into one number. Where the utility weighted total
  is shown, it is labelled as the person's own weights over their own
  judgments and shown beside the vector, never alone.
- No probability wording. A screen never says "N% chance"; it shows the
  qualitative level or the range the evidence supports, and it shows
  `confidence` as a worded level of support, never as odds of an outcome.
- Outcomes are compared with EXPECTATIONS (an intervention's `expected`,
  a hypothesis's `predictions`), never rendered as a verdict on the
  decision or the person. A rejected hypothesis reads "the hypothesis
  changed", never as a failure mark; caution and waiting are never
  labelled irrational.

## Flow

```
screen  --apply(mutation)-->  ModelProvider  --service.save-->  repository (localStorage)
                                   |
                            evaluateSystem(model)  -> `evaluated` for every screen
```

- `useModel()` (src/components/model-provider.tsx) gives `model`, `evaluated`,
  `apply(fn)`, `lastError`, `clearError`, `models`, `isSample`, `seedId`,
  `seedLabel`, `availableDomains`, `defaultDomain`, `migratedFrom`,
  `createBlank({name, systemType, domainId, domainVersion?, location?})`
  (the domain is EXPLICIT; the kind is a label), `switchModel`,
  `deleteModel`, `resetToSample` (the application's seed), plus (3b)
  `asOf` / `setAsOf(date | null)` (evaluate values and targets as of a past
  date; reset on every system switch) and `exportModel()` /
  `importModel(text, replace)`.

## Values and targets are histories (schema v4)

- A stored input variable has NO current value: it has `values`, an
  append-only list of value entries, and every variable has `targets`, an
  append-only list of target entries. `evaluated.variables` /
  `variableById` give the resolved VIEW (`currentValue`, `desiredValue`,
  `targetMode`, `sourceType`, `confidence`, `valueEntry`, `targetEntry`,
  `valueResolution`, `targetResolution`). Screens read the view and write
  through the mutations; they never touch `values` / `targets` directly.
- Recording: `recordValue(model, id, {value, sourceType, confidence, valid?,
  observed?, recordedAt?, evidence?, observationIds?, range?, note?})` and
  `recordTarget(model, id, {desiredValue, targetMode?, valid?, note?})`.
  `valid` is WHEN THE VALUE APPLIES (a TemporalRef, exact, approximate,
  range or unknown, kept as written); omit it and the entry is known from
  the recording instant on (`validBasis: "recorded"`) — never earlier.
  `recordedAt` is when the app recorded it. The two are different clocks;
  a screen shows both ("Applies as of …", "Recorded on …").
- `updateVariable(model, id, patch)` keeps its convenience fields:
  `currentValue`, `sourceType`, `confidence`, `desiredValue`, `targetMode`
  APPEND entries (with optional `valid`, `recordedAt`, `note`); they never
  rewrite an earlier entry.
- Correction of a wrong entry: `correctValue` / `correctTarget` append a
  new entry that names the old one (`supersedesId`); the old one becomes
  `superseded`. Withdrawal: `retractValue` / `retractTarget` need a reason
  and mark the entry `retracted`. Nothing is ever deleted from a history.
- Resolution (src/model/history.ts): among active entries with an
  orderable time whose start is at or before the instant, the latest start
  wins; a date-only instant means the end of that day. Before the first
  orderable entry: UNKNOWN (`before_first`), never the later value. Only
  unorderable entries: UNKNOWN (`unorderable_only`), the entries are kept
  and reported. Same start, different values: AMBIGUOUS, nothing chosen,
  a warning issue names the variable; the person corrects or retracts.
- Derived variables are SHELLS: notes, targets and judgments only; a value
  entry on one fails validation and `recordValue` refuses it. `addMember`
  materializes member-scope shells (`ensureDerivedShells`). An archived
  member's shells and histories are kept; their derived values are
  computed only with `includeArchivedMembers`.
- `evaluateSystem(model, { now?, asOf?, includeArchivedMembers? })`:
  `asOf` reconstructs VALUES and TARGETS at that instant under TODAY'S
  relationships, constraints, hypotheses, domain definition AND domain
  collections (collection items are not dated until 3d); `evaluated.clock` says which
  instant was used and `evaluated.issues` carries an "info" note. A stored
  signature snapshot (now stamped `valuesAsOf`) remains the record of a
  whole past model.
- Export / import: `ModelService.exportModel(id)` returns one system with
  its complete history as JSON; `importModel(text, {replace})` validates
  and migrates BEFORE storing, stores nothing on failure, and refuses an
  existing id unless `replace` is true.

- `apply(fn)` runs a PURE mutation `fn: (model) => model` from
  `src/services/mutations.ts`, persists the result, and returns `true`; a
  refused edit sets `lastError` and returns `false`. Screens must show
  `lastError` near the control that caused it.
- Never build a model object by hand in a screen; compose mutations.
  `replaceModel` exists only for the two attractor text areas.

## Mutations (all `(model, ...) => SystemModel`, throw `MutationError`)

Profile/members: `updateProfile`, `addMember`, `updateMember`,
`archiveMember` / `restoreMember` (the normal lifecycle), `removeMember`
(refused while `memberReferences(model, id).total > 0`),
`setCurrentAttractor`, `setDesiredAttractor`.
Collections (schema v5): `addCollectionItem(model, name, item)`,
`updateCollectionItem(model, name, id, patch)`, `removeCollectionItem(model,
name, id)` (also drops the item's event refs), `collectionItems(model, name)`.
The collection must be DECLARED by the system's registered domain and hold
`origin: "domain"`; items are validated with the pack's item schema and
their `subjectFields` must name an existing member (active or archived) or
null. A collection preserved from an older format (`origin:
"legacy_universal"`) or undeclared by the domain is opaque: kept, exported,
never evaluated, never edited here, and it blocks hard deletion of a member
(`memberReferences(...).unresolvedCollections`). The household pack's typed
wrappers (`addIncomeSource`, `updateIncomeSource`, `removeIncomeSource`,
`incomeSourcesOf`) live in `src/features/household/income.ts` (a FEATURE
module above the generic services; only household application code imports
it). Schema-valid
is not domain-valid: `collectionProblems(model)` names the first invalid
item of a declared collection; `commit` and `ModelService.save` refuse it,
`evaluateSystem` withholds that collection from calculations with a warning.
Variables: `addVariable` (inputs only; `subjectId` is REQUIRED — a member id,
the system id, or `null` = unassigned; `key` defaults to the id or a slug of
the name; a domain-derived key is refused), `updateVariable` (derived fields
protected), `assignVariableSubject`, `removeVariable` (cascades to
relationships, links, actions).
Relationships: `addRelationship` (`kind` REQUIRED: unclassified |
causal_hypothesis | association | definitional | constraint;
`participatesInDynamics` may be true only for causal_hypothesis and
definitional), `updateRelationship`, `setRelationshipKind`,
`setRelationshipDynamics`, `setRelationshipEnabled`, `removeRelationship`
(cascades), `setLoopAnnotation`.
Events: `addEvent` (kind shock | change | intervention | outcome | decision,
`occurred` is a TemporalRef — see src/calculations/time.ts), `updateEvent`,
`removeEvent`; every linked id must exist.
Hypothesis falsification: `setHypothesisStatus(model, id, status, {at, note})`
appends to `reviewLog`; `addDisconfirmingCondition`,
`removeDisconfirmingCondition`, `addKillCriterion`, `setKillCriterionStatus`
(the person decides), `readKillCriterion` (the engine only reads).
Action extensions: `setActionExtension(model, actionId, domainId, {schemaVersion,
payload})`, `removeActionExtension` — opaque, versioned domain data.
Snapshots: `addSignatureSnapshot` (immutable), `updateSignatureMeta`.
Constraints: `addConstraint`, `updateConstraint`, `removeConstraint`.
Observations: `addObservation`, `updateObservation`, `removeObservation`,
`linkObservation(obsId, {kind, id})`, `unlinkObservation`.
Hypotheses: `addHypothesis`, `updateHypothesis`, `setHypothesisStatus`,
`removeHypothesis`, `attachObservationToHypothesis(hypId, obsId, role)`,
`detachObservationFromHypothesis`, `ensureLoopHypothesis({loopId, statement})`.
Ids: pass none and `nextId(model, prefix)` assigns one.

## Rules the mutations enforce

- A relationship needs two different existing variables; one edge per
  source->target pair (edit it, do not duplicate).
- Derived variables cannot be removed or given a value.
- Observation links and hypothesis references must point at existing
  entities; an observation cannot both support and contradict one hypothesis.
- One loop hypothesis per loop id.
- Subjects: every `subjectId` / collection subject field must be the system id, an existing
  member id (active OR archived — history keeps its subject), or `null`.
  Nothing ever defaults an unknown subject to the household.
- Dynamics: `participatesInDynamics: true` on an ineligible kind is refused
  (schema and mutation); `updateRelationship` to an ineligible kind clears it.
- Unknown ≠ zero: a variable with `currentValue: null` cannot take a scenario
  delta; derived values and projections with a missing input are UNKNOWN /
  skipped with the missing inputs named.

## Evaluated data (src/model/evaluate.ts)

`evaluated.domain` = the registered DomainDefinition the model names
(`domainDefinitionId` + version). Resolve keys with `resolveVariable(
evaluated.variables, model.id, ref)` where `ref` is `systemRef(key)`,
`subjectRef(key, memberId)`, or `refFor(key, knownSubjectId, model.id)`.
There is no null in a reference: `Variable.subjectId === null` means
UNASSIGNED in storage and such a variable resolves for nobody.
`evaluated.derived[]` = one computation per definition per subject
(`{variable, definition, subjectId, missingInputs}`): a system-scope
definition once, a member-scope definition once per ACTIVE member.
`evaluated.relationships` = ENABLED edges that TAKE PART IN DYNAMICS with
valid endpoints (what loops use); `evaluated.allRelationships` = every
stored edge; `evaluated.disabledRelationshipCount`,
`evaluated.nonDynamicsRelationshipCount`,
`evaluated.unclassifiedRelationshipCount`, `evaluated.unassignedVariables`
(they feed no calculation until assigned). `evaluated.loops[]` carry
`polarity`, `meanStrength`, `pressure`, `cycleTimeMonths`, `edgeLagMonths[]`,
`slowestHorizon`, `hypothesis?`, `status` (never more than the hypothesis
says), `observationIds`. `evaluated.observations.byVariable /
byRelationship / byConstraint / byHypothesis` index observations.
`evaluated.actions[i].feasibility` has `hardViolations`, `softViolations`,
`suitability`, `unverified`, `unchecked`, `unconfirmedViolations`.

## Lags (src/calculations/lag.ts)

Stored as `{value, unit}` with unit days | weeks | months | years. Use
`formatLag(lag)` for display, `lagToMonths` only for arithmetic,
`horizonOfMonths` / `formatMonths` for cumulative values. Never show a lag
in a unit the person did not choose without saying so.

## History screen (structural discovery, read-only)

`/history` calls `describeInterval` from `src/discovery` on the stored
model and renders its buckets and sentences. It never writes: no
mutation, no hypothesis, no snapshot. "Explore this pattern" opens an
explanatory card; proposing a hypothesis from it is a later stage behind
the proposal / approval kernel. The screen's words are the discovery
layer's templates (`historySentences`, `CAUSATION_DISCLAIMER`,
`EXPLORE_PATTERN_TEXT`), pinned by tests/discovery/language.test.ts: a
value recorded again is a repeated record, never evidence that it held in
between; a value that still resolves is the model's state, never an
observation in the period; low variation is the A23 display convention
and only with a reference range; nothing names a cause.

## Explore screen (structural discovery step 2, read-only)

`/explore` opens from a "repeated" History row (exact recurrence only) with
a `PatternRef` in the URL (`encodePatternRef` / `decodePatternRef`; a
malformed reference is refused, never repaired) and renders `crossContext`:
occurrences and contrasts with their own temporal extents, what differed,
what was the same, what was also true when the pattern did not happen,
what is unresolved (missing != conflicting != varied within a broad period
!= only an older value standing != incomplete contrast evidence), and
possible explanations. Candidates come ONLY from the person's own drafts
(per-viewer browser storage, never the model) and from hypotheses linked
to the record deterministically (`linkedHypotheses`: predictions, kill
criteria, relationships, observations; never wording). The domain's
`explanationCatalogue` supplies QUESTIONS under the three generic loci
(`internal_to_subject`, `external_to_subject`, `interaction`, labelled in
the domain's words); a question becomes a candidate only when the person
writes one from it. A heading with nothing grounded shows "No grounded
candidate of this kind yet." "Investigate this explanation" is inert (Step 4 wires it to the
proposal kernel, whose review inbox `/proposals` now exists) until
the proposal / approval kernel exists. No mutation, no confidence, no
ranking, no score.

## Domain-driven screens (Checkpoint 3)

Generic screens read the ACTIVE DOMAIN (`evaluated.domain`) for every word
or list that depends on the kind of system: `subjectLabel` /
`subjectLabelPluralOf(domain)` for subjects (the stored field stays
`profile.members`; read it through `subjectsOf(model)`), `kinds` as
datalist SUGGESTIONS for the kind label (any label is allowed and never
implies the domain), `collections[].route/label` for navigation,
`collections[].onboarding` for getting-started steps,
`collections[].scenarioFields` for direct item edits in the scenario
screen, `collections[].provenanceField` for provenance counts, and
`presentation.headlineKeys` / `presentation.scenarioPresets` for the
dashboard and the presets. A screen never imports `@/domains/household`;
the one household route (`/income`) and the household feature module are
the documented exceptions, pinned by tests/architecture.

## Wording

Strength is a MODEL JUDGMENT, never an estimated causal coefficient.
A loop is a hypothesis with a status; "accepted" is a working reading, not
proof. Observations are kept verbatim and are never values.
