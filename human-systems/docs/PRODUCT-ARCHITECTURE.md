# Human Systems — Product Architecture

Status: APPROVED DIRECTION (2026-09-15). This document describes the target
architecture: structured core, freeform shell. Sections marked ROADMAP are
not implemented; sections marked CURRENT describe code on `main` today.
Binding rules live in docs/FOUNDATIONS.md and CLAUDE.md; this document
applies them to the product shape and never relaxes them.

Two sentences govern everything below:

    DO NOT HARD-CODE REALITY.  HARD-CODE EPISTEMIC DISCIPLINE.

    STRUCTURAL DISCOVERY IS THE ANALYTICAL CORE.
    CHAT IS AN INTERFACE TO THAT CORE.

---

## 1. The hierarchy

    HUMAN
        defines what matters (which system, subjects, variables, groups,
          relationships, hypotheses, formulas, targets, constraints)
        supplies information (observations, values, events, documents,
          notes, speech)
        approves every change to canonical state

    AI
        translates human language into typed proposals
        retrieves the relevant context (minimum necessary)
        proposes structure (observations, variables, values, events,
          relationships, constraints, hypotheses, groups, formulas)
        selects and requests calculations from the engine
        proposes hypotheses and questions
        explains engine results in plain language
        NEVER silently mutates canonical state
        NEVER invents a number or becomes the source of a calculated result

    DETERMINISTIC ENGINE
        owns canonical structured state (the typed model)
        history (append-only values and targets, as-of resolution)
        graph mechanics (relationship kinds, loops, propagation, influence)
        formulas (pack-authored and user-authored, executed here only)
        calculations (feasibility, signatures, persistence, scenarios)
        provenance (source type, evidence, assumption ids, resolution states)
        invariants (docs/FOUNDATIONS.md Part F; enforced by schema,
          mutations and tests)

The flow:

    human language / notes / voice / graph
                ↓
              AI (translate, retrieve, propose)
                ↓
        proposed structured changes (typed, validated, dry-run diffed)
                ↓
           HUMAN APPROVAL
                ↓
        structured system model (canonical; JSON; migrated; backed up)
                ↓
       deterministic engine (calculate, resolve, analyse)
                ↓
              AI (explain, ask, propose hypotheses)

Markdown, prose, transcripts and chat logs are inputs and projections.
They are never the canonical database.

## 2. Three layers

### 2.1 Flexible human model

The person constructs their own system. The engine imposes no vocabulary
about reality, only the object kinds it can reason about:

    System / Subject      Variable + value history + target history
    Observation           Evidence (source material)
    Event / Shock         Intervention / Action
    Relationship          Constraint
    Hypothesis            Derived definition (formula)
    Group (organisation)  Structural snapshot
    Time (structured references, five clocks kept apart)

"Monthly income", "emergency fund", "Miami migration", "insurance cost",
"customer concentration" are NOT engine concepts. They are user-created
variables, pack vocabulary, formulas or hypotheses. A person may build
"Miami real estate", "My career", "My restaurant" or "Cuba's external
dependency" without the engine having heard of any of them.

A domain pack is a useful starting vocabulary, versioned, registered with
the engine, never required, and never an ontology of reality.

### 2.2 Deterministic reasoning kernel

The engine is the only place a number is computed, a history resolved, a
loop enumerated, a constraint checked, a signature built or persistence
described. Every result carries provenance: the inputs it read, the
assumption ids it used, what was unknown, how each value was resolved. It
executes stored formulas only; there is no ad hoc evaluation path.

### 2.3 AI interpretation and interface

The AI reads through typed tools, proposes through typed tools, and
explains. It cannot reach the model except through a proposal the person
approved, and it cannot produce a stored numeric result. Its instructions
carry the constitution, including the prohibitions on authoritative
prescription, fabricated probability and causal language for persistence.

## 3. Provenance follows the original source

    AI TRANSPORT != AI SOURCE
    proposal author != information provenance
    source != truth

The AI is often only a translator between human language and structured
data. Provenance records where the information came from, not who carried
it:

| The person says or supplies | Provenance of the proposed entry |
|---|---|
| "My reserves are $6,000 as of September 14." | `self_reported`; the utterance is linked as evidence |
| "My rent went up to $1,850." | `self_reported` |
| A bank statement or document showing a figure | `observed` or `measured` per the existing vocabulary, with the document as the Source |
| A rough guess the person marks as such | `estimated` |
| The AI's own reading, e.g. "income instability appears to reinforce short-horizon decisions" | `ai_inferred`, and it enters as a proposed HYPOTHESIS or interpretation, never as an observed fact |

Every proposal therefore carries two separate fields: `sourceType` (the
provenance of the information, chosen from the existing vocabulary) and
`proposedBy` (`ai` or `human`, with the conversation turn or Source id).
The original human material, the utterance, note, transcript or document,
is stored verbatim as evidence and linked from what it produced. This
preserves the existing rule that a source type is provenance, never truth
(FOUNDATIONS G.7): a self-report can be wrong, and the chain shows where
it came from.

## 4. Numbers

    AI never INVENTS a number and never becomes the authoritative
    source of a CALCULATED result.

It may faithfully extract and propose a number the person or a document
explicitly supplied (that number's provenance is the person's or the
document's, section 3). It may request a deterministic calculation:

    person supplies   reserves = 6000, essential expenses = 2000
    AI requests       bufferMonths(reserves, expenses)   (a stored formula)
    engine returns    3, with inputs, assumption ids and unknown mask
    AI explains       "3 months of essential expenses, from the two
                       values you gave"

The authoritative stored or derived result always comes from the engine.
The AI may select which calculation applies, compose a formula proposal
(section 10), and interpret the result. It never states a number it
computed itself as a fact about the model.

## 5. Typed AI tool contract (ROADMAP)

Two families. READ tools execute immediately, locally, against the model
and return engine results. PROPOSE tools return a `MutationProposal` that
does nothing until approved.

READ (no approval; every call logged and visible to the person)

    queryVariables(filter)            resolved view, keys, subjects
    queryHistory(variableId, interval) entries, resolution, persistence description
    queryGraph(variableId?, kinds?)   relationships, loops, influence
    comparePeriods(from, to)          two as-of evaluations, movement and stability
    queryEvents(interval, kinds?)
    queryHypotheses(status?)          with kill-criterion readings
    requestCalculation(formulaKey, subjectId)   a STORED formula only
    requestScenario(changes)

PROPOSE, additive (low risk; standard confirmation)

    proposeObservation    proposeVariable     proposeValueEntry
    proposeTarget         proposeRelationship proposeEvent
    proposeConstraint     proposeHypothesis   proposeGroup
    proposeFormula

PROPOSE, consequential (stronger confirmation; see section 6)

    proposeCorrection(entryId, patch, reason)
    proposeRetraction(entryId, reason)
    proposeSubjectReassignment(variableId, subjectId)
    proposeHypothesisStatus(hypothesisId, status, note)
    proposeArchive(memberId)  /  proposeRemoval(entityId) where the engine supports it

Every proposal payload is the input type of an existing pure mutation
(`(model, input) => model`, validated, throws `MutationError`). The AI
never edits JSON; it fills a typed form the person sees.

For an MVP the consequential family may be withheld from the AI. That is
a staging decision, not an architectural rule: the person must be able to
say "that $6,000 was wrong, it should have been $5,500" or "reject that
hypothesis, the evidence no longer supports it" and have the AI translate
the explicit instruction into a consequential proposal. What is permanent
is that the AI never decides on its own to correct, retract, reclassify,
reassign or remove anything.

## 6. Confirmation and diff flow (ROADMAP)

    utterance
      → ContextBuilder (section 9)
      → AIAdapter.turn(context, tools)
      → zero or more READ calls, executed locally, results returned to the AI
      → answer text + ProposalSet (validated against the tool schema;
        anything outside the vocabulary is rejected before display)
      → each proposal is DRY-RUN on a copy of the model: the diff is
        computed (entities added, entries appended, links changed,
        before/after for consequential proposals) and any MutationError
        is captured
      → the person sees one card per proposal: what it will do, the exact
        fields, the source text it came from, the dry-run diff, any refusal
      → Approve / Edit / Reject per card, or Approve all ADDITIVE cards
      → approved proposals run through the real mutations in order

Confirmation levels:

- Additive proposals: one tap per card, or approve-all.
- Consequential proposals: shown with an explicit before/after, never
  included in approve-all, confirmed one at a time with the reason
  visible, and the reason is stored on the resulting entry (corrections
  and retractions already require one).

Rejected proposals stay in the conversation record and never touch the
model. Approved proposals stamp `proposedBy` and link the conversation
turn as evidence; `sourceType` follows section 3.

## 7. Freeform capture (ROADMAP)

    raw material (text, paste, Markdown, transcript, document, map node,
                  chat turn)
      → stored verbatim as a Source { id, kind, text, capturedAt, subjectId? }
      → AI extraction through PROPOSE tools only
      → proposal cards, each citing the span of the Source it came from
      → approval
      → mutations, with the Source linked as evidence on observations and
        as provenance on entries

A person may begin with "Tell me what's going on" and end the first
session with a few observations, two variables with dated values and one
hypothesis, all approved, and no form. Extracted structure is proposed
structure; the person's words remain the evidence.

## 8. Tree versus graph (ROADMAP)

Hierarchy and causality are different things. The mind map's tree is
ORGANISATION; the relationship graph is CLAIMS about the world.

    Group { id, name, parentGroupId | null, subjectId | null, notes }
    Variable.groupId?  Constraint.groupId?  Hypothesis.groupId?  Event.groupId?

A group carries no direction, strength, lag or dynamics and the engine
ignores it entirely. Relationships stay the only edges and keep their
epistemic kind and dynamics opt-in. A node can live under "Cost" for
organisation and have a causal edge into "Demand". No causal relationship
is ever created to draw a tree.

The map view renders groups as the tree, relationships as the graph (with
a toggle to show edges across branches), events on a timeline, and value
history on each node.

## 9. Context selection and privacy (ROADMAP)

Design toward MINIMUM NECESSARY CONTEXT, never the whole model.

1. Resolve referents locally: named variables, subjects, dates, event
   types, by matching names, keys and observation text.
2. Compute every deterministic answer locally first (histories,
   comparisons, loops, persistence, formulas). Numbers exist before the
   AI sees anything.
3. Assemble the slice: referenced entities, their one-hop relationships,
   the histories inside the asked interval, linked observations, and the
   methodology instructions.
4. Widen only through READ calls the AI makes, each logged and shown to
   the person as "looked at: …".
5. Redaction by class: human-meaning statements (FOUNDATIONS E.2 class 3)
   only when the question is about them; archived subjects only when
   named; other systems never.
6. Everything sent is recorded in the conversation log.

The provider is an adapter (`AIAdapter.turn(context, tools)`), exercised
in tests by a scripted mock. The production provider, its cost and the
transport (a small function holding the key, or the person's own key from
the browser) are decided before any real call, not before the design.

## 10. User-defined formulas (ROADMAP)

Extend `DerivedDefinition` with an expression variant beside the existing
code variant:

    { kind: "expression", expression: Expr, version, statement,
      authoredBy: "user" | "ai_proposed_user_approved" | "pack" }

`Expr` is a small AST: number literals, references `{ key, from:
"system" | "subject" }`, the four operations, `sum`, `mean`, `min`,
`max`, `abs`, and aggregation over a domain-declared collection. A parser
turns spreadsheet-style text into the AST; a validator resolves every
reference, declares the inputs (which the engine already requires),
rejects unknown names and cycles; an interpreter evaluates with unknown
propagation (any unknown operand yields unknown and names the missing
input). No `eval`, no JavaScript strings. Formulas are versioned on the
system; editing creates a new version and derived shells keep their
histories. The AI may draft the text and the statement; the validator
decides; the person approves.

## 11. Markdown's role

Readable projection, portable interchange, notebook page, AI context,
methodology. Never canonical state. Export renders the system as sections
(Variables with histories, Relationships, Observations, Events,
Hypotheses, Groups) with stable ids in headings. Import is a PROPOSAL
STREAM: parse, diff by id against the current model, and turn every
difference into a card. Ambiguity (a renamed heading, a missing id, a
value without a date) becomes a proposal with a question, never a silent
rewrite of structured history. Free prose that does not parse becomes a
Source for extraction. JSON remains the machine format.

## 12. Structural discovery stays central

The shell exists to feed and expose the cycle:

    observations → history → persistence → candidate common denominator
    → hypothesis → prediction → later evidence → retain / revise / reject

- Capture feeds observations and dated values, the raw material of
  persistence.
- The "What persisted?" surface (docs: structural discovery checkpoint)
  is the chat's most important READ tool: "what remained common across
  the last three years?" is answered with engine evidence and the
  forbidden-phrase discipline (never "hidden cause", "invariant", "will
  continue", "explains the outcome").
- Candidate common denominators reach the person as hypothesis PROPOSAL
  cards drafted from persistence evidence, never created by the AI.
- Later, the persistent-condition hypothesis kind and prediction
  resolution plug into the same READ and PROPOSE tools without changing
  the shell.

## 13. Domain-agnostic cleanup before the shell (ROADMAP)

The universal engine still carries household shape. Smallest refactor,
each step a separate PR:

1. Vocabulary: open `SystemTypeSchema` and the signature `domain` enum to
   strings validated against the registered domain; register an empty
   generic domain by default; replace household wording in generic
   signature code.
2. File moves: `calculations/household.ts` and `compounding.ts` into
   `src/domains/household/`.
3. Collections: `model.collections[name]` typed by the domain's declared
   collection schemas; household declares `incomeSources`;
   `DerivedContext.collection(name)` replaces `incomeSources`. One
   migration. Must precede 3d.
4. Utility: open `UtilityDimensionSchema` to domain-declared strings;
   retire `valuesFit` and `personalityFit` from the universal list.
5. Prompt: the domain supplies its prompt fragment; the generic prompt
   speaks only of systems, subjects and variables.

## 14. What is CURRENT and what moves

Reused unchanged: history resolution, evaluation, derived engine (the
expression variant is added beside `compute`), domain registry,
migrations, calculations (except the two household files), signatures,
scenarios, repositories, export and import, every mutation, the type
schemas, the tests, the foundations, and the screens as manual editors.

Superseded or moved: `src/ai/prompt.ts` and `schema.ts` fold into the
tool contract and `ProposalSet`; `src/app/ai/page.tsx` becomes the
capture and proposal surface; the two household calculation files move
into the pack; top-level `incomeSources` moves behind collections; the
utility enum moves to the domain; the "Attractor" page is renamed
"Recurring state". Nothing is deleted from the engine.

Known conflict with the current code: the existing AI review screen
stamps values extracted from the person's own text as `ai_inferred`.
Under section 3 those are `self_reported` with the text as evidence; the
capture surface corrects this when it replaces that screen.

## 15. Staged roadmap (ROADMAP, not implementation; order approved 2026-09-15)

1. Domain-agnostic cleanup (section 13, all five steps; one migration).
2. Structural discovery core + History / What persisted UI:
   `describePersistence`, interval description, manual snapshots,
   questions gated by explicit approval, built in the section 17 visual
   language; Attractor page renamed.
3. 3c evidence convergence on the clean vocabulary.
4. Proposal / approval kernel (`MutationProposal`, dry-run diff, review
   cards with the two confirmation levels, provenance and `proposedBy`
   stamping, scripted mock adapter) + organisational Groups (section 8).
5. Home / Map / History / Library shell with the mock adapter: Source
   records, capture box, deterministic "What I'm seeing", the four-place
   navigation, existing screens re-homed under Library and Details.
6. User formulas: AST, parser, validator, interpreter, `proposeFormula`.
7. Context builder and production AI (READ tools, chat surface, voice);
   provider, privacy, cost and transport decided here, before any real
   call.
8. Persistent-condition hypothesis kind and prediction resolution.
9. 3d income refinement on the domain-owned collection.

Ordering rationale: the product's distinctive capability is "what
remained common while everything else changed", so the current
structured engine demonstrates it visibly before the model is made
easier to populate; no generic surface is built on household leakage
that already has to move; the proposal kernel precedes the shell because
every capture write and every persistence question is a review card;
Groups sit with the kernel because the Map is a primary screen.

## 16. Product surface (APPROVED DIRECTION, not implemented)

    THE ENGINE MAY BE COMPLEX.
    THE USER EXPERIENCE SHOULD NOT FEEL COMPLEX.

    NEVER REQUIRE THE USER TO UNDERSTAND AN INTERNAL OBJECT
    BEFORE THEY CAN EXPRESS THE IDEA IT REPRESENTS.

The person should feel they are talking to a smart notebook, not operating
a systems-science database. The complexity that exists today is the
engine's objects exposed as screens; that complexity stays underneath.
The person mainly does three things: tell the system what is happening,
see the map it builds, and review what the system thinks it learned.

Ordinary statements are the interface, and the shell translates them:

| The person says | The model records (never shown as such) |
|---|---|
| "Uber has been slow again." | an observation, `self_reported`, with an approximate time in the person's words; "again" prompts a persistence check, it is not a fact |
| "My rent went up." | a value entry proposal on the rent variable, `self_reported` |
| "I think these two things are connected." | a relationship proposal of kind unclassified or causal_hypothesis, outside dynamics until opted in |
| "That started around March." | a TemporalRef of kind approx, precision month, text kept verbatim |
| "This number came from my bank statement." | provenance `observed` with the document as the Source |
| "What stayed the same?" | the persistence description over the value histories and snapshots |

Nobody is asked to know what a hypothesis, a TemporalRef, a source type,
a persistence indicator or a snapshot is.

### 16.1 The normal interaction

A reply is never a verdict. Its shape is:

    what I heard
    what the existing model shows
    what is uncertain
    what I propose recording
    what question may be worth exploring

It does not tell the person what to do (FOUNDATIONS G.13). Provenance is
always visible, in plain language, never as schema terms, ids or decimals
by default:

    "you said"   "from your document"   "estimated"   "AI interpretation"
    "fairly sure" / "rough"  instead of 0.85 / 0.4

### 16.2 Four places, everything else is progressive disclosure

Primary navigation converges on HOME, MAP, HISTORY, LIBRARY. There is no
primary navigation item for variables, constraints, relationships,
hypotheses, events, actions, signatures, attractors or derived variables:
those are engine concepts, reached by disclosure.

**HOME** feels like a notebook, not a dashboard.

    system name
    "What are you thinking about?"
    [ freeform capture box, later voice ]

    WHAT I'M SEEING
      3 things changed
      2 conditions persisted
      1 important unknown
    [What changed?] [What persisted?] [What am I uncertain about?]

    Recent
      Sep 14  Cash reserves → $6,000
      Sep 10  New job possibility

The summary is DERIVED DETERMINISTICALLY: interval description over value
histories (changed / stayed within range), persistence description, and
the question-priority heuristic for the unknown. AI is not required to
populate this view. The capture box stores a Source and, once the proposal
kernel exists, shows review cards:

    I found a few things you may want to record.
    ✓ Uber income has been lower this month        (observation)
    ✓ Rideshare income stability                    (possible variable)
    ? Full-time rideshare may be becoming less sustainable   (possible hypothesis)
    [Approve all]   [Review]

Approve all covers additive cards only; consequential proposals are
confirmed one at a time (section 6).

**MAP** is the person's visual model: the organisational tree (groups,
section 8) and the relationship graph on one canvas, distinct internally.
A branch such as Finances → Income / Expenses / Savings is organisation;
an arrow Income stability → Cash buffer is a relationship claim. The
default node shows name, current value or state if appropriate, and at
most one short status. Dragging is view state, never model state.
Selecting a node opens a drawer:

    Cash buffer
    Current        $4,200
    Previously     $1,800 · Jan 2026
    Observed for   8 months
    Connected to   Income stability, Monthly expenses
    Evidence       3 records
    Where from     you said · Sep 14
    [View history]  [Show analysis]

Ids, schema names, relationship implementation fields, raw confidence
values and assumption ids appear only under Show analysis / Details.

**HISTORY** makes 3b understandable. Timeline first:

    JAN          APR          JUL          SEP
     |            |            |            |
    $1,800      $2,600       $3,900       $4,200

Then plain-language interval comparison: what changed, what stayed
relatively stable, what is unknown, what lacks enough history. The
sentences come from fixed descriptive templates ("Housing cost stayed
approximately the same", "Income instability was present throughout the
recorded period"); "substantially" and "approximately" are labelled
display conventions under Details. WHAT PERSISTED? is one of the central
product experiences and a Home button:

    What persisted?            Jan 2025 — Sep 2026
    Income sources changed        4 times
    Work arrangements changed     3 times
    Monthly income varied         substantially

    These conditions remained present:
    • Dependence on variable income   observed across 19 months
    • Low financial buffer            present across 4 recorded periods
    • Need for immediate income       supported by 6 observations

    These are observations of persistence, not claims of cause.
    [Explore the pattern]

Explore the pattern asks "Is one of these worth investigating as a common
denominator?" and only an explicit yes creates a hypothesis. The
progression is: I noticed something → the history confirms persistence →
maybe this matters → let's test it. Never: fill out forty-seven fields.

**LIBRARY** re-homes the existing advanced screens and objects
(observations, evidence, hypotheses, events, variables, relationships,
constraints, actions, snapshots, formulas, sources and documents). Nothing
is thrown away; it is where people inspect the machinery, and it is not
the everyday workflow. The current sixteen routes become Library and
Details, which is what avoids a rewrite.

### 16.3 Progressive disclosure (a UI principle)

    Level 1  ordinary language
             "Customer concentration stayed high."
    Level 2  explanation, evidence, history
             "Observed across 14 months from five customer records."
    Level 3  advanced mathematical and epistemic detail
             H = Σ(s_i²) · value 0.67 · formula version · input ids ·
             provenance · unknown mask · assumption ids

Same engine, different depth. Every Level 1 sentence has a Level 2 and a
Level 3 behind it, and no Level 1 sentence claims more than Level 3
supports (the forbidden persistence phrases apply at every level).

### 16.4 Onboarding

Never schema setup. It begins:

    "What are you trying to understand?"
    "Tell me the story in your own words. You don't need to organize it."

The system gradually proposes structure. A first session can end with a
few observations, a few variables, one or two relationships and perhaps
one hypothesis, all approved through review cards, without visiting a
configuration page. The same interface serves "why do I keep ending up in
the same financial situation" and "what keeps Miami real estate strong and
what could break that pattern".

### 16.5 Visual identity

Closer to a chat, a notebook, a mind map and a timeline than to the
dashboard-style analytical application the codebase started as. The
design language is written down as a short document at the step that
builds the shell, so screens are built to it rather than restyled after.

## 17. What this architecture never does

No AI arithmetic as stored truth. No silent mutation. No proposal outside
the typed vocabulary. No hidden objective. No universal score, no
probability of an outcome, no personality type, no authoritative
prescription (FOUNDATIONS G.13 permits person-requested conditional
comparison under its six conditions). No hard-coded list of what reality
contains. No causal claim from persistence. No whole-model context by
default. No repurposing of a person's data.
