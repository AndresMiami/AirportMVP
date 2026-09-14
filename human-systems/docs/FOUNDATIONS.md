# Human Systems Dynamics — Foundations

The scientific, mathematical and normative foundation of the Human Systems
engine. This document is REQUIRED READING before any schema, AI, domain or
UI change; CLAUDE.md, README.md and docs/EDITING-CONTRACT.md point here and
tests/architecture/foundations.test.ts keeps those pointers alive.

It has three parts that must never be confused with one another:

- Part A — EMPIRICAL / MATHEMATICAL FOUNDATIONS: tools that are valid on
  their own terms (identities, measures, graph structure, logic).
- Part B — MODELING CONVENTIONS AND HYPOTHESES: our normalisations,
  signatures, heuristics and thresholds. Working choices, open to revision,
  each labelled in src/domain/assumptions.ts.
- Part C — NORMATIVE DESIGN PRINCIPLES: human sovereignty, dignity, the
  limits of quantification, anti-exploitation, data minimisation. These are
  deliberate design commitments. Nothing in Part A proves them, and they do
  not need proving to be binding on this codebase.

Part D restates the operating principles of the original theory
reconstruction, Part E defines the measurement boundary and the treatment
of human meaning and intuition, and Part F is the backend constitution:
the short invariant list every future decision is checked against.

---

## Part A — Empirical and mathematical foundations

What the engine does with numbers is, at its core, bookkeeping over a
directed graph with explicit uncertainty. The pieces that stand on their
own:

1. **Accounting identities.** Total income, surplus, floor ratio, buffer
   months, debt burden. Given their definitions they are exact; their
   confidence is exactly the confidence of their inputs (A13 records the
   weakest-link rule).
2. **Concentration measures.** The Herfindahl index (A3) is a well-defined
   concentration measure. Only the reading of a value ("0.48 is high") is
   a convention.
3. **Directed-graph structure.** Cycle enumeration, loop polarity from the
   count of negative edges (A9), reachability and centrality are standard
   graph theory and system-dynamics practice, valid for any edge set.
   What is NOT grounded is the edge set itself: every edge is a judgment.
4. **Lag arithmetic.** Unit conversion and cumulative lag along a path
   (A16) are exact; the horizon classes are display conventions.
5. **Constraint satisfaction.** Hard-constraint feasibility (A14) is logic,
   not estimation. A constraint with no machine-checkable rule is reported
   "unchecked", never scored.
6. **Explicit unknowns.** Unknown is a state that propagates (A20). A
   missing input makes a derived value, a projection and a signature
   dimension UNKNOWN. This is a design decision about representation, but
   it is also the only mathematically honest treatment of a missing
   operand: there is no arithmetic that turns "unknown" into 0.
7. **Structured time.** Four clocks are kept apart: when something was
   observed, when a value held, when a snapshot was taken, how long an
   effect takes (a lag). Structured time references compare by interval
   and are "not orderable" when no interval exists.
8. **Data-engineering invariants.** Validated schemas, versioned
   migrations with backups, immutable snapshots, pure mutations with
   cascading removal, subject attribution with an explicit unassigned
   state. These make the epistemic separations below enforceable rather
   than aspirational.

## Part B — Modeling conventions and hypotheses

Everything in this part is a working convention or an explicit hypothesis.
Each is registered with an id in src/domain/assumptions.ts and cited by
the code and the screens that use it. None is a law, none is validated,
and every number they produce reads as a rank or a band before it reads as
a measurement.

- **Step models** for career capital and productive capital (A6, A7):
  their scale is invented and they are labelled hypotheses. A projected
  curve is a model assumption, never a forecast.
- **Edge strength** as a 0..1 judgment, **loop gain** as a product, the
  **loop pressure index** (A10), **sign-only propagation** (A12):
  qualitative reasoning aids with numbers attached.
- **Leverage** (A8): five ordinal judgments multiplied and divided. Only
  the RANK is meaningful. It ranks options for the person; it never ranks
  people.
- **Signature normalisation, thresholds, bands and weights** (A19, A21,
  A23, A24): conventions chosen by whoever wrote the definition, versioned
  with it, and shown next to every value. Maturity "experimental" is the
  honest default.
- **Question priority** (A22): a transparent heuristic. Its "importance"
  weight is the domain author's, not yet the person's; see Part E.6.
- **Per-source reliability** (A1): a judgment about a bad month written as
  a fraction. "Floor" is an expected value, not a worst case.
- **Self-assessed confidence**: stored as a number, uncalibrated; the
  interface must anchor it to worded levels.
- **The attractor**: the person's own description plus the reinforcing
  loops that plausibly hold it. A frame, not a detected object. The
  general update rule X(t+1) = F(X, S, P, A, E) is the theory's grammar;
  F is never estimated.
- **Structural signatures**: derived only, from the evaluated model, per
  subject, stamped with time and definition version, read as "position
  at t", never "is". The continuous vector is canonical; strips and bands
  are views; no configuration is ever named, ranked against other people,
  or collapsed into one number.

Where the model could create false precision (kept here as a standing
warning): decimals on judgment-derived quantities; aggregated dimensions
that look measured; compounding curves that read as forecasts; compact
strips that look categorical and final; "floor" that promises a worst
case. The remedies are display rules, not more math: ranks and bands
first, provenance one tap away, unknowns always visible.

## Part C — Normative design principles

These are commitments, not findings. They bind the codebase because the
people building it chose them, and they are recorded here so the choice is
explicit and reviewable.

### C.1 Human sovereignty

Human Systems Dynamics exists to increase a person's ability to understand
and direct their own life. The model serves the person represented by the
data. The person does not serve the model.

Understanding a person's situation is never permission to manipulate that
person. The same information that reveals a vulnerability in order to
strengthen resilience could be used to exploit it. That inversion is
prohibited:

    The system may understand vulnerability to help the person.
    It must never exploit vulnerability to benefit another party.

Human judgment retains final authority. The tool describes structure,
constrains claims with evidence, helps interpretation, and asks questions.
It never decides for the person and never tells anyone what to do.

### C.2 Anti-exploitation

No exploitation layer may be built on top of the understanding layer.

Information about fears, financial pressure, relationships, behavioral
patterns, uncertainty, spiritual beliefs, emotional vulnerabilities,
constraints, health limitations, values, desperation and decision patterns
must never become a targeting profile for another party. The architecture
is designed against, and future work must not introduce:

- behavioral advertising or offers based on vulnerability;
- engagement, retention or conversion optimisation that uses the model;
- personalised pressure tactics or urgency manufactured from the data;
- employer screening, lender or insurer use of structural profiles;
- political persuasion based on psychological weaknesses;
- selling, sharing or brokering behavioral profiles;
- covert persuasion or A/B optimisation of the person's decisions.

This is a product principle even while none of these features exist and
the data never leaves the browser.

### C.3 The optimisation boundary

The system may help optimise MEANS. It must not define the person's ENDS,
openly or by default.

Mathematics may establish that option A yields more money than option B.
It cannot conclude that A is a better life. The person's stated values,
commitments and purposes are authoritative, and every ranking the engine
produces is a ranking against the person's own targets and constraints.

The optimisation target of the product itself is the person's explicit
goals and constraints. It is never engagement, time in app, conversion,
advertising revenue, purchases, retention, or any third party's objective.

    Mathematics describes structure.
    Evidence constrains claims.
    AI helps interpretation.
    The human supplies meaning and chooses.

### C.4 No fixed human "codes"

The diagnostic-car analogy is useful only for the idea of a compact,
inspectable state with a corpus behind it. It stops there. A human being
does not have permanent behavioral error codes.

Permitted vocabulary: structural signature, recurring pattern, observed
tendency, working hypothesis, current state, persistent condition.
Forbidden framing: type, code, trait-as-verdict, diagnosis, identity.

A pattern is not an identity. A current state is not destiny. A repeated
behavior is not necessarily a personality trait. The application is not a
clinical or diagnostic system unless a future regulated domain is
explicitly designed and validated for that purpose, and nothing in the
universal engine may assume such a domain.

### C.5 Dignity of language

The tool describes conditions and patterns in calm, neutral language. It
never evaluates the person, never moralises, and never infers motivation
from leisure, appearance or one event. "Weak" and "strong" describe the
structural position of a situation on a named dimension, never the person.

### C.6 Data minimisation and user control

Architectural constraints for all future storage, sync and AI work (nothing
beyond local browser storage exists today, and this section does not ask
for a cloud or privacy system to be built now):

- collect only what serves the person's stated purpose;
- preserve provenance on everything (source type, evidence, formula,
  definition version);
- allow correction; history records a correction, it does not erase it;
- allow export in a readable form, whole and per system;
- allow deletion, whole and per system, including backups;
- keep inferred information distinguishable from what the person entered
  (the `ai_inferred` and `estimated` source types exist for this and must
  never be collapsed into `self_reported`);
- avoid creating sensitive profiles the person did not ask for; a
  derived value is computed on demand, not accumulated into a dossier;
- never silently repurpose information collected for one purpose into
  another (an observation entered to size a buffer is not a marketing
  signal, an employment screen, or a training example);
- qualitative spiritual, value and meaning statements remain qualitative
  by default;
- any future sharing is explicit, understandable, scoped and revocable,
  and the default is no sharing.

## Part D — Operating principles of the theory (preserved)

The twenty principles of the theory reconstruction, kept as written and
now cross-referenced to the parts above.

1. An observation is a verbatim record; an interpretation is a hypothesis
   about it. They are separate entities and never merge silently.
2. Unknown is a state, never zero. Missing data is missing information,
   not weakness.
3. Every value carries provenance; every inferred value carries
   confidence; both stay visible wherever the value is shown.
4. Derived values are computed, never typed. Only inputs are edited, and
   inputs cite evidence.
5. State and dynamics are separate representations. Same values,
   different loops, different system.
6. Relationships are model judgments with direction, lag in the unit the
   person chose, confidence and evidence. Strength is never presented as
   an estimated causal coefficient. (Since 3a: an edge also carries an
   epistemic KIND and takes part in dynamics only by explicit opt-in.)
7. Loops are hypotheses with a review status. "Accepted" means a working
   reading, never a proof. Repetition across snapshots is reported as
   repetition, never as cause.
8. Predictability is not resilience. Amount, volatility, reliability,
   concentration, correlated failure and replacement latency are distinct
   properties of income.
9. A temporary state improvement is not structural change.
10. Hard constraints filter before anything is ranked. A mathematically
    attractive option that is infeasible for this body, this schedule,
    this family is not recommended.
11. Each member of a system is a distinct agent with their own objectives,
    constraints and dynamics. Nothing collapses them into one score or one
    motive. (Since 3a: every entity names its subject or is explicitly
    unassigned; the engine never averages members.)
12. Agency, persistence and willingness are real variables and are never
    inferred from leisure, appearance, or one event.
13. Historical snapshots are immutable. History must answer both "what
    changed" and "what stayed the same".
14. Precision never exceeds evidence. Every formula is labelled by its
    epistemic status.
15. There is no universal score, no probability of life success, no
    prediction. Scenario output is structural scenario analysis.
16. The tool asks the next most informative question, not every question.
17. Leverage is judged on impact, controllability, durability, cost and
    uncertainty, and only the ranking is meaningful.
18. Any non-empirical interpretation layer (traditional, practitioner) is
    architecturally separate and absent from the product.
19. Language stays calm and neutral. The tool describes conditions and
    patterns; it never evaluates the person. (Part C.5)
20. The person remains the final decision-maker. The tool never tells
    anyone what to do. (Part C.1)

Representation rules that follow from them, unchanged: time has four
clocks that must not be confused; uncertainty has three forms (explicit
unknown, anchored ordinal confidence, ranges for estimates); feedback is a
set of edge hypotheses from which loops are derived and never stored;
evidence is the observation entity and never becomes a value by itself;
provenance is a chain from source type to assumption id that every screen
can show.

## Part E — Limits of quantification, human meaning, and sovereignty

### E.1 What the engine is for, and what it is not

The mathematical engine models the parts of a person's situation that can
reasonably be represented: states, resources, constraints, dependencies,
buffers, events, relationships, feedback loops, uncertainty, change over
time, interventions and outcomes.

It does not exist to reduce a human being to numbers. Some aspects of a
life may be profoundly important without being meaningfully quantifiable:
meaning, spirituality, faith, love, dignity, intuition, identity, grief,
purpose, moral commitments, deeply held values. The system must know the
boundary of its own model.

    immeasurable != nonexistent

Do not assign a number merely because software can store one.

### E.2 The measurement boundary

Every piece of information the product holds falls into one of three
classes, and the class decides what the engine may do with it.

**1. Measurable / estimable.** Numbers, ranges, frequencies, dates,
ratios and calculations are reasonably defensible. Income, hours, reserves,
dates of events, counts of sources, a lag. These may carry values, units,
confidence, reference ranges and may enter formulas. Estimates carry
`estimated` or `self_reported` provenance and, where possible, a range.

**2. Interpretive.** Hypotheses such as "financial pressure may reinforce
short-horizon decision making." These are readings that gain or lose
evidential support. They live as Hypothesis, Relationship (kind
`causal_hypothesis` or `association`) and loop status; they carry
confidence and cited observations; they are NEVER automatically facts, and
the engine never promotes one to a fact by computation.

**3. Human meaning.** Values, spiritual beliefs, intuitions, moral
commitments, purposes and other qualitative realities the person says
matter. They may influence decisions and constrain options WITHOUT being
converted into artificial numeric weights.

    "I will not choose a path that prevents me from caring for my family."

This is preserved as the person's commitment: verbatim, attributed to its
subject, with its provenance. It may act as a hard constraint that filters
options. It is never turned into `familyImportance = 0.87`. The only
exception is when the person explicitly chooses a numeric representation
for a limited analytical purpose, and then the system labels that number
as the person's chosen convention, keeps the original statement beside it,
and never treats the number as a measurement of the value itself.

The existing schema already offers the seam for class 3 without any new
numeric field: an Observation holds the verbatim statement with subject,
date and source; a Constraint of type `hard` with NO machine-checkable
`check` is a commitment the feasibility check reports as "unchecked" and
never scores (A14). A future `Commitment` or qualitative-statement entity,
if one is ever added, must follow the same rule: text, subject, provenance,
links, and no value field. Spirituality, meaning, intuition and values are
NEVER encoded as scores, and no domain definition may declare a variable
whose unit is a person's meaning.

### E.3 Intuition is a human signal

    "Something about this opportunity feels wrong."

Intuition is neither proof nor noise. The system preserves the statement
as an observation (class 3, attributed, dated, verbatim) and may ask:

- What specifically feels wrong?
- Have you encountered something similar before?
- Is there an unmodeled constraint?
- Is this connected to an experience, a value or a fear?

The engine and the AI layer must never classify an intuition as irrational,
correct, incorrect, bias or truth. If the person, after those questions,
states a constraint or a hypothesis, THAT entity enters the model with its
own class and provenance; the intuition itself stays an observation.
Observation and interpretation remain separate.

### E.4 Ends and means in the engine

Every optimisation the engine performs is over means: feasibility against
the person's constraints, leverage ranked against the person's own
judgments, gaps against the person's own targets, questions that reduce
the person's uncertainty. Targets, target modes, constraints, utility
weights and hypothesis status are entered or approved by the person and
are the only legitimate objective. A domain definition may supply default
thresholds and weights as conventions; it may not supply the person's
ends.

### E.5 Signatures, patterns and identity

A structural signature is the position of a SITUATION on named dimensions
at a time, computed for one subject, with its unknown mask and its
confidence. It is not a description of who the person is. Persistence
across snapshots is reported as persistence of a condition, never as a
trait. The compact strip is a view of a vector, never a code.

### E.6 Open items this section creates

Recorded here so future work resolves them deliberately:

- The question-priority "importance" weight belongs to the domain author.
  The person should be able to accept or override it per system so the
  "next question" is steered by their purpose, not the definition's.
- Utility dimensions named `valuesFit` and `personalityFit` ask the person
  to write a value's importance as a number in -1..1. See the schema
  review in the 2026-09-14 foundation report; a redesign toward
  qualitative commitments plus a small, per-person set of means-oriented
  dimensions is owed.
- Agency variables (persistence, quality of effort, retraining readiness)
  are 0..1 self-ratings in the household domain. They stay class 1 only
  because the person enters them knowingly; every screen that shows them
  must label them as the person's own rating, and no engine rule may
  infer them.

## Part F — Backend constitution

Short invariants that guide every schema, AI, domain and UI decision.
Tests pin the ones that can be tested; the rest are review criteria.

    unknown != zero
    observation != interpretation
    association != causation
    immeasurable != nonexistent
    pattern != identity
    model != person
    optimization != meaning
    understanding vulnerability != permission to exploit it
    the model serves the person
    human judgment retains final authority

Consequences a reviewer checks on every change:

- No universal score, probability of success, prediction or personality
  type, for a person or a system.
- No numeric field for meaning, spirituality, intuition, faith, love,
  dignity, grief, purpose or values. Qualitative stays qualitative unless
  the person chooses a labelled convention.
- No engine rule promotes an interpretation to a fact, an association to a
  cause, an unknown to a number, or an unassigned subject to a person.
- No optimisation target other than the person's own goals and
  constraints. No engagement, retention, conversion or third-party metric
  anywhere in the model, the services or the screens.
- No profile leaves the person's control. No silent repurposing. Inferred
  and entered information stay distinguishable.
- Language describes conditions, never the person.

---

Revision history: 2026-09-14 — first edition, integrating the theory
reconstruction (Part D) with the measurement boundary, human meaning,
sovereignty, anti-exploitation and constitution sections.
