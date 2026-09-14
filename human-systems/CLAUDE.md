@AGENTS.md

# Human Systems — architectural instructions

CORE PRODUCT PRINCIPLE: The underlying Human Systems engine is the product.
Personal finance, career, household, business opportunity, and future
domains are configurations of the engine, not separate implementations. The
backend must therefore remain domain-agnostic wherever possible.
Domain-specific variables, questions, formulas, thresholds and opportunity
models live in versioned definitions/modules layered over a generic
evidence → state → dynamics → intervention → outcome engine. Do not
hard-code the current founder, household, or commercial-pool experiment
into the universal ontology. The personal examples in this repository are
the first test dataset, nothing more.

NON-NEGOTIABLE: A user's growing history is an asset of the model. Never
design the backend only around the current snapshot.

The generic backend objects are: Person / System, Observation, Evidence,
Variable + dated values, Constraint, Relationship, Hypothesis, Event /
Shock, Intervention / Action, Derived metric, Signature snapshot, Outcome
observation. A domain definition says which variables, questions, formulas
and thresholds are relevant to a particular problem; the engine handles
evidence, uncertainty, time, dependencies, constraints, graphs, scenarios
and history.

Epistemic rules (never violated): AI interprets; evidence constrains; the
model calculates; the human approves. Observation ≠ interpretation. Unknown
≠ zero. Derived values are computed, never typed. Every value carries
provenance and confidence. State and dynamics are separate representations.
Hypotheses are never facts; loops are hypotheses with a status. Snapshots
are immutable. No universal score, no probability of success, no
prediction, no personality type. The person is the final decision-maker.

Working docs: README.md (architecture), docs/EDITING-CONTRACT.md (how
screens change the model), src/domain/assumptions.ts (every formula's
epistemic status).
