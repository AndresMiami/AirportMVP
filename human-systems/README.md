# Human Systems Lens

A web application for analysing a personal or household system with
dynamical-systems thinking: slow structural variables, feedback loops,
buffers, dependencies, constraints, and leverage. It is **not** a financial
calculator and **not** a life coach. Every number carries a source type and
a confidence; every formula is a labelled model assumption.

Status: iteration 2 — the structural model is editable. Schema v2 adds
editable relationships with lags in the unit the person chose, hard/soft
constraints, first-class Observations, Hypotheses with a review status
(loops stay hypotheses), a blank-household workflow, several systems side
by side, and versioned localStorage state with migrations. No
authentication, no cloud, no real AI provider (a deterministic mock
exercises the review contract).

## Run

```bash
npm install --legacy-peer-deps   # vitest 4 + npm's peer resolver need the flag
npm run dev                      # http://localhost:3000
npm test                         # vitest, 85 tests
npm run typecheck
npm run lint
npm run build
```

## Architecture

```
src/
  types/          Zod schemas + inferred types (the data model)
  domain/         vocabulary (labels) and the model-assumption registry (A1..A15)
  calculations/   pure math: household ratios, HHI, compounding, leverage,
                  gap, graph (loops, pressure, propagation), feasibility, utility
  model/          derived-variable definitions, evaluateSystem(), migrations,
                  blank-model factory
  scenarios/      applyScenario() and compareScenario() (tendencies by horizon)
  ai/             strict output schema, provider interface, system prompt, mock
  data/           the fictional sample household (tests + demo only)
  repositories/   persistence boundary: several models + active id
                  (localStorage with migration on load, in-memory)
  services/       ModelService (active system, seed, create blank, save) and
                  mutations.ts: every edit as a pure, validated function
  components/     React only: provider, primitives, editors, network diagram
  app/            Next.js routes (one screen per directory)
tests/            vitest; tests/architecture pins the model layer UI-free
docs/EDITING-CONTRACT.md  how screens change the model
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
  older records on load and rejects what it cannot validate.
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
