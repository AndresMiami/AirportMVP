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
    source != truth
    action != identity
    experiment failure != human failure
    preserving optionality has value
    the model serves the person
    human judgment retains final authority
    current != historical
    recordedAt != effectiveAt
    missing history != permission to backfill
    target change != state change
    derived != entered
    approximate time != exact time

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
class 3 (human meaning) never gets a number. SOURCE != TRUTH: a source
type (measured, observed, self_reported, calculated, estimated,
ai_inferred, unknown) records provenance only; no code or copy treats
measured/observed as fact or self_reported as an estimate, and no large
truth-status schema is added. NO AUTHORITATIVE PRESCRIPTION (FOUNDATIONS
G.13): no engine, service, screen or AI contract may compute, render or
propose "you must / you should / the correct decision is X" unasked or
as a verdict; a person-REQUESTED conditional comparison ("given the
goals, constraints and evidence you supplied, option B is currently
better supported on these dimensions...") is allowed only when it is
grounded in the person's stated objectives and constraints, its reasons
are inspectable, its assumptions and unknowns are visible, uncertainty is
preserved, no hidden objective is optimised, and the person retains final
authority; ranking is analysis, not command; rankings are over means
against the person's own targets with every dimension inspectable and no
bet dimension (downside, reversibility, capital or time at risk, time
until evidence, optionality) collapsed into one number; no probability
is ever fabricated (unknown stays unknown or a qualitative level;
confidence is ordinal support, not a probability of an outcome); no
decision is ever judged by its outcome alone, and a retrospective
classification is the person's, never computed; an action or experiment
never becomes an attribute of the person. MEMORY THROUGH TIME (3b,
FOUNDATIONS Part F): the stored truth of an input variable is its
append-only value history and of any variable its target history;
"current" is a VIEW resolved at a clock instant (src/model/history.ts);
an entry is never edited in place (a correction supersedes, a retraction
marks, nothing is deleted); a migrated value is known from the record's
last save forward and NEVER backfilled; an as-of query before the first
orderable entry is UNKNOWN; approximate or unorderable time stays as
written and is never sorted by guess; two entries that disagree for the
same start are reported as ambiguous, not chosen between; derived
variables are shells that never hold a typed value; as-of evaluation
reconstructs values and targets only, under today's graph and today's
domain collections, and stored snapshots remain the record of a past whole
model. Schema v5 (Checkpoint 2): domain data lives in DECLARED collections
(`model.collections[name]`, household declares `incomeSources`); the
engine knows no "income" — derived formulas read `ctx.collection(name)`;
a collection a domain does not declare, or one preserved from the v4
universal field under another domain, is kept opaque: exported, never
evaluated, never edited by typed tools, never a reason to call the model
invalid. Migration dispatches on `schemaVersion` only, never on field
presence; a v4 record that is present but malformed in a field the step
reads is REFUSED (typed MigrationStepError -> ordinary failure, nothing
stored), never sanitized. Schema v6: `Hypothesis.confidence` may be null =
NOT ASSESSED (unknown confidence != 50%); nothing manufactures 0.5 for a
hypothesis, null is never read as low, no calculation reads the field,
and v5 -> v6 keeps every stored number exactly while refusing malformed
v5 confidence (missing / null / string / out of range) as corrupt data,
never laundering it into "not assessed". Other entities' confidence
contracts are unchanged. STORAGE SAFETY (Checkpoint 3.1): UNREADABLE !=
EMPTY — if the system does not understand your data, its first duty is to
preserve it. An ABSENT primary key is the ONLY empty store (an empty
string is present malformed data); a present key that is not a readable
store envelope is a typed StorageError on every read and write, bytes
untouched, never normalized; a raw model record that
fails migration still COUNTS as stored (`hasStoredModels`, `unreadable`),
so startup never seeds over it and both `save` and the guarded
`saveIfRevision` refuse to overwrite it explicitly; the legacy
single-model key (absent = none; "" = malformed) is imported only when it
parses, has an id and collides with nothing, and is removed only AFTER the primary write
landed. The app shows a storage notice instead of substituting the
sample. Recovery / export / deletion of unreadable data is an explicit
tool for later. DOMAIN-AGNOSTIC (Checkpoint 3): the generic
service knows no domain and no sample (`createBlank` requires a domainId;
the seed is injected from `src/bootstrap/household-app.ts`, the ONLY
place the household product is chosen); generic screens read every
domain-dependent word or list from the active domain (subjectLabel,
kinds as suggestions, collection route/label/onboarding/scenarioFields/
provenanceField, presentation.headlineKeys/scenarioPresets); the only
files allowed to import household code are the pack itself,
`domains/index.ts`, `data/sample-household.ts`,
`bootstrap/household-app.ts`, `features/household/income.ts`,
`app/income/page.tsx` and the provider's single bootstrap import
(tests/architecture pins the list; tests/model/neutral-domain proves a
neutral domain runs with household modules mocked to throw).
STRUCTURAL DISCOVERY (src/discovery, the /history screen): RESOLUTION !=
OBSERVATION != RECURRENCE and RECORDED AGAIN != CONTINUOUSLY PRESENT !=
STRUCTURAL != CAUSAL. The discovery layer describes RECORDS with
non-exclusive evidence facts (exact repetition needs two distinct
application times and strict equality, no threshold; low recorded
variation only under the explicitly applied A23 display convention with a
reference range; an explicit interval claim only from a stored `range`
assertion; a value that still resolves because nothing replaced it is
carry-forward, never an observation; explicit unknowns, ambiguity and
unorderable timing are evidence with unresolved meaning, never zero
evidence). It never ranks "most structural", never computes a score,
never names a cause; sentences come from fixed templates and tests pin
the forbidden phrases (causes, structurally persistent, invariant, hidden
cause, generator, will continue, improved, weakened). Derived variables
are excluded from repetition candidates and recomputed only on request
under today's structure, caveated. Snapshots are secondary evidence
("recorded in k of n saved snapshots"). "Explore this pattern" is
read-only except for Investigate, which proposes (see INVESTIGATE below). EXPLORE
(src/discovery/cross-context.ts, /explore): occurrences O = {t: Y(t) = y*}
vs contrasts C = {t: Y(t) != y*}; COMMON ACROSS OCCURRENCES != EXPLANATORY;
ABSENCE IS NOT DIFFERENCE (unknown, ambiguous or carried contrast readings
never count as different); partial contrast coverage is never filed as a
complete distinction; an occurrence keeps its own temporal extent and
context is read over it; the engine knows only three loci (internal /
external to the subject, interaction) and a domain supplies QUESTIONS,
never candidates; hypotheses are linked by explicit links, never wording;
no candidate is created, ranked, scored or given a confidence.
INVESTIGATE (Step 4): "Investigate this explanation" creates a PROPOSAL
(one addHypothesis: the draft's words, the pattern's subject, confidence
null, nothing else invented) and never a hypothesis; the proposal's
pattern, Explore-comparison and catalogue-question bases are RE-RESOLVED
through the same deterministic engine at every revalidation, so the
review expires when anything Explore showed changes even if the
hypothesis text is identical; approval means "keep this as a working
hypothesis to test", never "this explanation is true".
AI BOUNDARY (Step 5B, src/ai/context.ts): AI interprets, never
calculates; it receives the least DETERMINISTIC, INSPECTABLE, task-scoped
context (`buildAiContext(model, task, selection)`: six tasks, explicit
item-kind allowlists, subject scope = subject + system / the pattern's
contextSubjectsFor scope / selected subjects), every value with its basis
(recorded_here / carried_forward / calculated / explicit_unknown /
ambiguous / unknown) and stored judgments labelled as judgments, the
Explore comparison as an INPUT (never recomputed), a manifest of what was
included, excluded and why, and a contextHash over content only (never the
clock; "values as of" is explicit content). Epistemic states for AI output
are directly_stated / interpretive / tentative / unresolved, never numbers.
THREE IDENTITIES (5C): sourceRevisionHash (local model state, audit
only) != contextHash (= hash of the provider payload, which is task +
items and nothing else: no manifest, revision, clock or exclusion
bookkeeping ever crosses the transport boundary) != the AI output item
id. Sensitivity is TRANSITIVE and composites are withheld whole, never
trimmed. AI output (src/ai/response.ts) is strict and task-enveloped:
extractions quote a cited source verbatim and are directly_stated (says
it, not true); interpretations and candidate explanations are
interpretive / tentative / unresolved and may not claim cause, proof or
odds; every ref must exist in the exact payload; one bad item rejects the
whole response; the schema has no numeric epistemic field. AI -> PROPOSAL (5D): a validated
candidate explanation becomes, only when the person clicks "Review as
hypothesis", exactly one addHypothesis proposal (the AI's words, the
pattern's subject, confidence null, nothing else invented) with
proposedBy = person and an immutable `ai_output` ORIGIN basis beside the
re-resolvable evidence basis (pattern, Explore comparison, cited
records) — origin is never evidence, staleness follows the evidence, and
the same adapter + contextHash + output id never opens a second
proposal. Every other AI output kind is display-only. The legacy /ai
analysis is read-only; nothing AI-derived reaches the model except
through the proposal kernel. AI -> Variable and AI -> Observation
stay blocked by canonical-mutation seams (manufactured 0.5 judgments and
sourceType unknown / confidence 0 in addVariable; required numeric
confidence in addObservation), recorded in docs/PRODUCT-ARCHITECTURE.md.
PRODUCT SHELL (Step 6A): primary navigation is exactly Home / History /
Map / Library (src/components/nav.tsx); nothing was deleted — the old
dashboard is `/overview`, `/map` wraps feedback-map, `/library` indexes
every advanced screen (Records / Model / Investigation / Advanced
analysis) and tests/architecture/shell.test.ts pins that every route is
reachable from it. Home (src/app/page.tsx) is a capture box with a
browser-local draft (not a Source record yet), a read-only "Reflection
demo" over the mock provider, and three card kinds computed by
src/features/home/cards.ts from existing systems only (History-engine
repetition -> Explore, ledger open count -> /proposals, non-rejected
hypotheses). Home speaks ordinary language: never "structural gap",
"attractor", "model health", "variables", "recurrence set" or
"cross-context" there. VISUAL CONVERGENCE (6A.1, from reviewed
screenshots): the notebook is the product — Home shows ONE strongest
repetition worded for people by `recurrenceSentence` ("Total debt was
$4,000 on 7 recorded dates between February 2025 and June 2026."; the
History engine keeps its own sentence and its record/application-time
counts, which never appear on Home) plus a quiet "N more patterns in
History" link; absence renders nothing (no empty-state cards); the
review card appears only with open proposals; working explanations are a
compact line with one truncated example; the action ("Reflect on this"
with a Demo badge) appears only after typing, the writing surface
auto-grows with no resize handle and no microphone until voice exists;
the ONE as-of treatment is the slim `AsOfStrip` under the primary
navigation on every page ("Viewing June 1, 2025 · Back to today"),
never a second banner; storage errors keep their own notice. HOME IS
FROZEN (6A.1.1): the strip says "Values as of …" because asOf resolves
VALUES historically while relationships, hypotheses and constraints
stay today's structure — never "Viewing"; the demo reflection is stored
with the contextHash it answered (src/features/home/reflection.ts:
`homeContext` builds the interpret_free_text context from model + draft
+ as-of, `visibleReflection` shows a result only while the hash still
matches, nothing reruns the mock); the demo response renders the
interpretation as its own paragraph with no "A tentative reading:"
label and questions under "Question to consider" (Home is not the
diagnostics screen; the AI contract is unchanged); the footer is
"Fictional sample · Your systems and advanced details are in Library."
Do not polish Home further unless a usability test shows a concrete
problem. HISTORY (6B): SIMPLIFY THE PRESENTATION, NOT THE DISTINCTIONS —
the first layer is three ordinary questions (What changed? / What keeps
showing up? / What still needs more information?) worded by
src/features/history/wording.ts over the UNCHANGED discovery engine;
every engine distinction keeps its own row (tags Stayed close / As
stated / Old value still standing / Not enough history / Unknown; an
exact repetition needs no tag inside "What keeps showing up?"), exact
repetition hands /explore the exact same PatternRef (one row per
repeated value), the engine's own sentence, raw records with source and
confidence, resolution states, evidence facts and every record count
sit under Details, and the period, subject, the engineering counts, A23
convention, calculated values, snapshots and interval caveats sit under
Change period / Advanced / Notes. First-layer sentences carry a count
only where the finding needs it ("on 7 recorded dates", "only one
recorded value"), never "across N recorded values" (6B.1). Never move a
distinction out of the page to simplify it; move it behind a toggle. Next: Explore, then Review, then Map — one
coherent product over the existing capability, not more AI work.
PROPOSAL / APPROVAL KERNEL (src/kernel, Step 1 core, no UI yet): every
future write by an AI, a feature or a person outside the existing forms
is a `MutationProposal` over REGISTERED ordinary mutation kinds;
materialization freezes ids and clocks so reviewed request = materialized
request = dry-run request = approval request; the revision is the exact
canonical serialization minus `updatedAt`; the review fingerprint covers
what the person reviewed (diff, semantic diff, RESOLVED basis, warnings,
consequence class, expected outputs), so a changed basis makes the
proposal stale even when the mutation diff is identical; approval is
two-phase through the proposal ledger and `ModelService.saveIfRevision`
(canonical state changes ONLY after the guarded save succeeds; stale,
conflict and persistence failure write nothing; `applying` proposals are
reconciled on startup from the stored revision, never guessed). The
consequence table is pinned code, never the proposer's choice. REVIEW
UI (Step 2, /proposals): the card answers seven fixed questions in
ordinary language derived from the record, always says under the basis
that the records explain the proposal and do not make it true, keeps the
mechanical diff under Details, approves ordinary proposals in one explicit
step and consequential ones only after a second confirmation naming the
consequence, shows a stale proposal as before / changed since / now with
approval withheld until an explicit fresh review, and offers a failed
proposal ONLY an explicit "Check again and retry" (never automatic). The
provider adopts the persisted model returned by the guarded approval;
it never saves it again, and a failed approval leaves React state alone.
Startup recovery runs before any card can act.

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

Working docs: docs/FOUNDATIONS.md (the foundation, above),
docs/PRODUCT-ARCHITECTURE.md (the approved direction: structured core +
freeform shell; human defines, AI proposes, engine owns state — ROADMAP
sections are not implemented), README.md (architecture),
docs/EDITING-CONTRACT.md (how screens change the model),
src/domain/assumptions.ts (every formula's epistemic status).
