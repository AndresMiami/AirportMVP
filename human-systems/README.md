# Human Systems Lens

A web application for analysing a personal or household system with
dynamical-systems thinking: slow structural variables, feedback loops,
buffers, dependencies, constraints, and leverage. It is **not** a financial
calculator and **not** a life coach. Every number carries a source type and
a confidence; every formula is a labelled model assumption.

Status: MVP iteration 1 — data model, calculation library, fictional sample
household, dashboard, current-vs-desired comparison, feedback-loop
detection, network diagram, scenario simulator, and unit tests. Local
persistence only (browser localStorage). No authentication, no cloud, no
real AI provider yet (a deterministic mock exercises the review contract).

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
  model/          derived-variable definitions and evaluateSystem()
  scenarios/      applyScenario() and compareScenario()
  ai/             strict output schema, provider interface, system prompt, mock
  data/           the fictional sample household
  repositories/   persistence boundary (localStorage, in-memory)
  services/       ModelService (load-or-seed, save, guarded updates)
  components/     React only: provider, primitives, network diagram, fields
  app/            Next.js routes (one screen per directory)
tests/            vitest; tests/architecture pins the model layer UI-free
```

Rules the code enforces:

- A variable is an **input** (entered, with provenance) or **derived**
  (recomputed by a named formula; its stored value is never trusted).
- Scenarios change inputs and income sources only; everything else is
  recomputed through the same `evaluateSystem` the screens use.
- AI output is validated with Zod and lands on a review screen; approved
  items enter the model stamped `ai_inferred` with the cited evidence.
- Directories under `src/` other than `components/` and `app/` must not
  import React or Next (tested).

## Model (labelled assumptions, not laws)

See `src/domain/assumptions.ts` and the Evidence / assumptions screen.
Headline formulas: floor ratio, buffer months, HHI concentration, failure
correlation, share-weighted volatility and replacement latency, the two
compounding step models, the leverage score with denominator floors, gap
normalisation with target modes, loop polarity/gain/pressure, sign-only
directional propagation, and hard-constraint feasibility.
