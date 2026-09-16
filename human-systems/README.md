# Human Systems Lens

A web application for analysing a personal or household system with
dynamical-systems thinking: slow structural variables, feedback loops,
buffers, dependencies, constraints, and leverage. It is **not** a financial
calculator and **not** a life coach. Every number carries a source type and
a confidence; every formula is a labelled model assumption.

Status: schema v5, domain-agnostic cleanup COMPLETE (Checkpoints 1-3):
the household income sources are a DECLARED domain collection, not a
universal field; records from other domains are preserved, never
interpreted; the generic service, screens, navigation, creation flow and
prompt assembly know no household (the application configures the
household product in `src/bootstrap/household-app.ts`, and a neutral
domain runs the whole engine with every household module mocked to throw).
Migration 3b gave the model memory through time.
Input values and all targets are append-only histories; "current" is a
view; `evaluateSystem(model, { asOf })` reconstructs values and targets at
a past date (under today's structure and domain collections, and it says so);
a migrated value is known from its record's last save forward and never
backfilled; derived variables are shells that never hold a typed value;
one system exports and imports with its whole history. Migration 3a made
the engine domain-agnostic. Every
variable, constraint, action, hypothesis, event and income source names its
SUBJECT (a member, the whole system, or explicitly UNASSIGNED — never a
guessed household); domain definitions (variables, formulas, projections,
signature, constraint templates, event types) are versioned configuration
registered with the engine, the household being the first; relationships
carry an epistemic KIND and take part in loops/propagation only by explicit
opt-in; events/shocks/interventions live in a log with structured time;
hypotheses record what would weaken them; migration v2→v3 keeps a backup
and creates no claim. Schema v2 added editable relationships with lags,
hard/soft constraints, Observations, Hypotheses with a review status, a
blank-system workflow and versioned localStorage with migrations. No
authentication, no cloud, no real AI provider (a deterministic mock
exercises the review contract).

## Run

```bash
npm install --legacy-peer-deps   # vitest 4 + npm's peer resolver need the flag
npm run dev                      # http://localhost:3000
npm test                         # vitest, 249 tests
npm run typecheck
npm run lint
npm run build
```

## Foundations

`docs/FOUNDATIONS.md` is the scientific and normative foundation and is
required reading before changing schemas, AI, domains or screens. It keeps
three things apart: what is mathematically grounded (identities, measures,
graph structure, explicit unknowns), what is our modeling convention
(signatures, leverage, thresholds, step models, all labelled in
`src/domain/assumptions.ts`), and what is a deliberate normative
commitment (human sovereignty, the limits of quantification,
anti-exploitation, data minimisation). Its constitution in one breath:
unknown ≠ zero, observation ≠ interpretation, association ≠ causation,
immeasurable ≠ nonexistent, pattern ≠ identity, model ≠ person,
optimization ≠ meaning, understanding vulnerability ≠ permission to exploit
it, decision quality ≠ outcome quality, unknown ≠ probability, action ≠
identity, preserving optionality has value, the model serves the person,
source ≠ truth, human judgment retains final authority. Part G
(decision-making under uncertainty) is why the product issues no
authoritative prescription: it shows what is known, assumed, unknown,
survivable, reversible and testable; a comparison appears only when the
person asks and with its reasons and assumptions visible; the person
decides.

## Architecture

```
src/
  types/          Zod schemas + inferred types (the data model)
  domain/         vocabulary (labels) and the model-assumption registry (A1..A15)
  calculations/   pure engine math: leverage, gap, graph (loops, pressure,
                  propagation), feasibility, evaluation-dimension view,
                  confidence, lag, time (household ratios and the
                  compounding step models live in the household pack)
  model/          domain.ts (the ENGINE-OWNED domain interface, registry and
                  the explicit-scope VariableRef resolver: systemRef /
                  subjectRef, never null), derived.ts (generic derived
                  evaluation: a definition declares scope system|member and
                  each input's source system|subject; member formulas run
                  once per active member, never averaged), evaluateSystem(),
                  migrations (v1→v2→v3), blank-model factory
  domains/        versioned domain CONFIGURATION layered over the engine:
                  household/ (keys, variables with subject scope, formulas,
                  projections, signature v1, constraint templates, event
                  types). Engine directories never import this (tested).
  discovery/      structural discovery (descriptive, deterministic):
                  describeVariableHistory, describeInterval,
                  describeSnapshotSeries, sentence templates
  signatures/     structural-signature engine: compute (per subject),
                  dynamics, compare, gap, questions, interpretation
  scenarios/      applyScenario() and compareScenario() (tendencies by horizon)
  ai/             strict output schema, provider interface, system prompt, mock
  data/           the fictional sample household (tests + demo only)
  repositories/   persistence boundary: several models + active id
                  (localStorage with migration on load, in-memory)
  services/       ModelService (active system, seed, create blank, save) and
                  mutations.ts: every edit as a pure, validated function
  components/     React only: provider, primitives, editors, network diagram
  app/            Next.js routes (one screen per directory)
tests/            vitest; tests/architecture pins the model layer UI-free and
                  the engine free of concrete domain imports; tests/model/
                  fake-domain proves a second domain needs no engine change
docs/FOUNDATIONS.md       the foundation: grounded math, conventions, principles
docs/PRODUCT-ARCHITECTURE.md the approved direction (structured core + freeform shell)
docs/EDITING-CONTRACT.md  how screens change the model
docs/SCHEMA-V3-PROPOSAL.md the staged v3 plan (3a shipped; 3b–3d pending)
```

Rules the code enforces:

- A variable is an **input** (entered, with provenance) or **derived**
  (recomputed by a named formula; its stored value is never trusted).
- Scenarios change inputs and income sources only; everything else is
  recomputed through the same `evaluateSystem` the screens use.
- AI output is validated with Zod and lands on a review screen; approved
  items enter the model stamped `ai_inferred` with the cited evidence.
- Every edit is a pure mutation in `src/services/mutations.ts` that returns
  a new, Zod-validated model or throws `MutationError`; removals cascade
  (a removed variable takes its relationships, links and action targets).
- Stored state carries `schemaVersion`; `src/model/migrations.ts` upgrades
  older records on load and rejects what it cannot validate. The
  repository keeps the pre-migration record as a backup and a failed
  migration never writes. Migration creates no knowledge claim: person
  variables come out UNASSIGNED, relationships come out `unclassified`
  and outside dynamics, and no loop appears because of a migration.
- Unknown is never zero: a missing input makes the derived value, the
  projection and the signature dimension UNKNOWN, and scenario deltas on
  an unknown value are refused.
- A member who is referenced by anything (variables, income, constraints,
  actions, hypotheses, events, observations, snapshots) can be ARCHIVED but
  never deleted: history keeps its subject.
- There is no universal score: the gap screen reports counts and vectors
  only (`meanNormalizedGap` does not exist).
- History is never edited in place: recording appends, a correction
  supersedes, a retraction marks, nothing is deleted. An as-of query
  before the first orderable entry is unknown, never the later value.
  Approximate or unorderable time stays as written. Two entries that
  disagree for the same start are reported as ambiguous, not chosen.
- Relationship strength is a model judgment, never an estimated causal
  coefficient. A loop is a hypothesis with a status; "accepted" means a
  working reading, not proof. Observations are kept verbatim and never
  become values by themselves.
- Directories under `src/` other than `components/` and `app/` must not
  import React or Next (tested).

## Model (labelled assumptions, not laws)

See `src/domain/assumptions.ts` and the Evidence / assumptions screen.
Headline formulas: floor ratio, buffer months, HHI concentration, failure
correlation, share-weighted volatility and replacement latency, the two
compounding step models, the leverage score with denominator floors, gap
normalisation with target modes, loop polarity/gain/pressure, sign-only
directional propagation, and hard-constraint feasibility.
