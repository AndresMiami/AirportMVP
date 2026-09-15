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

FOUNDATION (required reading, binding): docs/FOUNDATIONS.md. Part A is
what is mathematically grounded, Part B our conventions and hypotheses,
Part C the normative design principles, Part E the measurement boundary
and Part F the backend constitution. Every schema, AI, domain and UI
change is reviewed against it. Its constitution:

    unknown != zero
    observation != interpretation
    association != causation
    immeasurable != nonexistent
    pattern != identity
    model != person
    optimization != meaning
    understanding vulnerability != permission to exploit it
    decision quality != outcome quality
    good outcome != good decision
    bad outcome != bad decision
    uncertainty != ignorance
    unknown != probability
    action != identity
    experiment failure != human failure
    preserving optionality has value
    the model serves the person
    human judgment retains final authority

Consequences for code: no universal score, probability of success,
prediction or personality type; no numeric field for meaning, spirituality,
intuition, faith, love, dignity, grief, purpose or values (qualitative
stays qualitative unless the person chooses a labelled convention); no
engine rule promotes interpretation to fact, association to cause, unknown
to number, or unassigned to a person; the only optimisation target is the
person's own goals and constraints (never engagement, retention, conversion
or a third party's objective); inferred and entered information stay
distinguishable; nothing is repurposed silently; language describes
conditions, never the person. A new numeric field about a person must say
which measurement-boundary class (FOUNDATIONS Part E.2) it belongs to, and
class 3 (human meaning) never gets a number. NO PRESCRIPTIVE OUTPUT
(FOUNDATIONS Part G): no engine, service, screen or AI contract may
compute, render or propose "you should / you must / do X"; rankings are
over means against the person's own targets with every dimension
inspectable and no bet dimension (downside, reversibility, capital or
time at risk, time until evidence, optionality) collapsed into one
number; no probability is ever fabricated (unknown stays unknown or a
qualitative level; confidence is ordinal support, not a probability of an
outcome); no decision is ever judged by its outcome alone, and a
retrospective classification is the person's, never computed; an action
or experiment never becomes an attribute of the person.

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

Working docs: docs/FOUNDATIONS.md (the foundation, above), README.md
(architecture), docs/EDITING-CONTRACT.md (how screens change the model),
src/domain/assumptions.ts (every formula's epistemic status).
