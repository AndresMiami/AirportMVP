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

## 15. Staged roadmap (ROADMAP, not implementation)

1. Cleanup steps 1 and 2 (vocabulary, file moves).
2. Proposal kernel: `MutationProposal`, dry-run diff, approval cards
   with the two confirmation levels, provenance and `proposedBy`
   stamping, scripted mock adapter, tests. No schema change.
3. Structural discovery checkpoint: `describePersistence`, the "What
   persisted?" screen, manual snapshots, questions as proposal cards,
   Attractor page renamed.
4. Cleanup steps 3 and 4 (collections, utility). One migration.
5. 3c evidence convergence on the clean vocabulary.
6. Capture shell: Source records, extraction through PROPOSE tools,
   capture page, mock adapter.
7. User formulas: AST, parser, validator, interpreter, `proposeFormula`.
8. Groups and the map view.
9. Context builder and chat surface with READ tools; provider, privacy,
   cost and transport decided here, before any real call.
10. Persistent-condition hypothesis kind and prediction resolution.
11. 3d income refinement on the domain-owned collection.

Ordering rationale: the proposal kernel comes first because both the
discovery checkpoint's questions and every chat write are proposal cards;
the descriptive discovery surface precedes the chat because it is
zero-schema and supplies the chat's most valuable READ tools; a minimal
capture shell precedes a conversational chat because capture needs only
PROPOSE tools and the mock.

## 16. What this architecture never does

No AI arithmetic as stored truth. No silent mutation. No proposal outside
the typed vocabulary. No hidden objective. No universal score, no
probability of an outcome, no personality type, no authoritative
prescription (FOUNDATIONS G.13 permits person-requested conditional
comparison under its six conditions). No hard-coded list of what reality
contains. No causal claim from persistence. No whole-model context by
default. No repurposing of a person's data.
