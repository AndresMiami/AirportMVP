# Editing contract (schema v2)

How UI screens change the model. Read this before writing an editor.

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

Profile/members: `updateProfile`, `addMember`, `updateMember`, `removeMember`,
`setCurrentAttractor`, `setDesiredAttractor`.
Income: `addIncomeSource`, `updateIncomeSource`, `removeIncomeSource`.
Variables: `addVariable` (inputs only), `updateVariable` (derived fields
protected), `removeVariable` (cascades to relationships, links, actions).
Relationships: `addRelationship`, `updateRelationship`,
`setRelationshipEnabled`, `removeRelationship` (cascades), `setLoopAnnotation`.
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

## Evaluated data (src/model/evaluate.ts)

`evaluated.relationships` = ENABLED edges with valid endpoints (what loops
use); `evaluated.allRelationships` = every stored edge;
`evaluated.disabledRelationshipCount`. `evaluated.loops[]` carry
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
