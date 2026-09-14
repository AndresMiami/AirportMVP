# Editing contract (schema v3)

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
- Inferred (`ai_inferred`, `estimated`) and entered (`self_reported`,
  `measured`, `observed`) information are visually distinguishable
  everywhere a value is shown.

## Flow

```
screen  --apply(mutation)-->  ModelProvider  --service.save-->  repository (localStorage)
                                   |
                            evaluateSystem(model)  -> `evaluated` for every screen
```

- `useModel()` (src/components/model-provider.tsx) gives `model`, `evaluated`,
  `apply(fn)`, `lastError`, `clearError`, `models`, `isSample`, `migratedFrom`,
  `createBlank`, `switchModel`, `deleteModel`, `resetToSample`.
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
Income: `addIncomeSource` (`earnerId`: member id or null), `updateIncomeSource`,
`removeIncomeSource`.
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
- Subjects: every `subjectId` / `earnerId` must be the system id, an existing
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

## Wording

Strength is a MODEL JUDGMENT, never an estimated causal coefficient.
A loop is a hypothesis with a status; "accepted" is a working reading, not
proof. Observations are kept verbatim and are never values.
