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

## 13. Domain-agnostic cleanup before the shell (DONE)

Checkpoint 1 (vocabulary, calculation moves, assumption split, evaluation
dimensions, categories, prompt seam) is DONE without a schema version
bump. Checkpoint 2 (collections seam + schema v5 migration) is DONE:
`model.collections[name]` envelopes with `origin` "domain" |
"legacy_universal", generic `collectionItemRefs` on events,
`ctx.collection(name)` / `ctx.collectionConfidence(name)`, generic
add/update/remove collection scenario ops, and `migrateV4toV5` folding the
universal `incomeSources` field by the record's REGISTERED domain
(household -> declared collection; other registered domain -> dropped when
empty, preserved as legacy when not; unregistered -> preserved). The v4 ->
v5 step refuses malformed input instead of sanitizing it (corrupt data is
not permission to drop or repair it; the record fails and nothing is
stored). Checkpoint 3 (generic screens + service default cleanup +
neutral-domain proof) is DONE, with no schema change: "the generic engine
does not require a household" now holds through services, components,
screens, navigation, the creation flow, prompt assembly and the
architecture tests. What moved:

- `ModelService` knows no domain and no sample. `createBlank` REQUIRES a
  `domainId` (the kind is a free label and never implies the domain);
  the seed for an empty store is a `SeedConfig {id, label, create}` in
  `ServiceOptions`; without one an empty store is an error, never an
  invented system; `resetSample` became `resetSeed`. The APPLICATION
  chooses the household product: `src/bootstrap/household-app.ts`
  registers the built-in domains, supplies the fictional sample as the
  seed and names the default domain for the creation form. The React
  provider is the composition root that injects it.
- `src/features/household/income.ts` holds the household income wrappers
  (feature -> services, feature -> pack; nothing generic imports it).
- Collection provenance is declared, never guessed: `CollectionDefinition.
  provenanceField` (household: `"sourceType"`); the Evidence page counts
  it only for a declared, domain-owned collection whose value parses as a
  SourceType. Opaque or undeclared collections contribute nothing.
- Presentation is configuration: `CollectionDefinition.onboarding` and
  `scenarioFields`, `DomainDefinition.presentation` (`headlineKeys`,
  `scenarioPresets`), `subjectLabelPlural`. The household pack supplies
  exactly the keys, presets and steps the screens used to hard-code; the
  engine never reads any of it.
- Navigation lists a collection screen only because the active domain
  declares `route` + `label`; getting-started words the subject step from
  `subjectLabel` and derives collection steps from declared collections;
  the creation form lists registered domains and suggests `domain.kinds`
  through a datalist (any label allowed); the profile shows the fixed
  domain and edits the kind as a label; constraint-check dimension
  suggestions come from the domain's templates and the system's own
  actions.
- `profile.members` stays the stored field (not migrated); generic code
  reads it through `subjectsOf(model)` and words it with the domain's
  subject label.
- Proofs: `tests/model/neutral-domain.test.ts` runs a two-input/one-ratio
  domain through creation, histories, derived values, loops, signature,
  scenarios, export/import and prompt assembly with every household
  module, the sample, the bootstrap and the feature mocked to THROW on
  load; `tests/architecture/domain-layering.test.ts` pins that the only
  files importing household code are `domains/index.ts`,
  `data/sample-household.ts`, `bootstrap/household-app.ts`,
  `features/household/income.ts`, `app/income/page.tsx` (the declared
  household collection route) and the provider's single bootstrap import.

Intentional household-specific application files after the cleanup:
`src/domains/household/*` (the pack), `src/data/sample-household.ts`,
`src/bootstrap/household-app.ts`, `src/features/household/income.ts`,
`src/app/income/page.tsx`. The plan below is kept as written; steps 1 to
5 are complete. This was the last domain-agnostic cleanup checkpoint.

FUTURE STORAGE HARDENING (recorded, not scheduled): `unreadable store !=
empty store`. `LocalStorageModelRepository.read()` treats malformed
top-level store JSON as an empty store, and an unreadable pre-store legacy
record is dropped. Both predate the migration work and are not domain
questions; once real users hold years of history, an unreadable store
must be reported and preserved, never silently replaced by an empty one.

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
2. Structural discovery core + History / What persisted UI — DONE
   (descriptive core): `src/discovery` with `describeVariableHistory`
   (non-exclusive evidence facts over one input variable's value history:
   exact repetition, low recorded variation under the explicitly applied
   A23 convention, explicit interval claims, last-known carry-forward,
   explicit unknowns and interruptions, ambiguity, unorderable and
   approximate timing, recorded-basis dates; a derived summary class that
   never replaces the facts), `describeInterval` (buckets, events as
   context, snapshots as secondary evidence, derived recomputation only on
   request and caveated), `describeSnapshotSeries`, fixed sentence
   templates and the forbidden-phrase discipline, and the read-only
   `/history` screen ("What changed", "What repeated or stayed similar in
   the records", "Only an old value still standing", "Not enough history",
   "Unknown", Details disclosure, the fixed causation disclaimer, and an
   explanatory "Explore this pattern" card that writes nothing). Remaining
   from this item: questions gated by explicit approval, the Attractor
   page rename, and the proposal step behind "Explore this pattern" (the
   proposal / approval kernel, item 4). EXPLORE steps 1-2 DONE:
   `crossContext` (occurrence vs contrast slices with their own extents;
   asserted / recorded-basis / range coverage vs carried-forward / unknown
   / ambiguous / varied-within-extent; common vs differing; background /
   differentiating / mixed only with COMPLETE contrast coverage, partial
   coverage never filed as a distinction; absence is not difference) and
   the read-only `/explore` screen with the domain-owned
   `explanationCatalogue` (questions under three generic loci, never
   candidates), deterministic hypothesis links, per-viewer drafts and an
   inert Investigate control. Steps 3-4 (proposals through the kernel;
   household orientation synthesis) wait.
3. 3c evidence convergence on the clean vocabulary.
4. Proposal / approval kernel (`MutationProposal`, dry-run diff, review
   cards with the two confirmation levels, provenance and `proposedBy`
   stamping, scripted mock adapter) + organisational Groups (section 8).
   KERNEL STEP 1 DONE (core only, no UI): `src/kernel` — proposal types
   (author person / ai / system_feature, basis refs, nine states:
   proposed, reviewed, approved, applying, applied, failed, rejected,
   stale, superseded); a registry of the 13 ordinary, fully
   materializable mutation kinds (shape check only, the mutation is the
   authority in dry-run); materialization freezes ids and clocks so the
   reviewed request IS the approved request; revision = exact canonical
   serialization minus `updatedAt`; dry-run on a clone with the
   exhaustive mechanical diff (every top-level key, pinned), semantic
   description built on the diff, "nothing else changes" only when the
   diff proves it, the pinned consequence table (`readKillCriterion`
   absent, `setKillCriterionStatus` consequential, unknown kinds
   consequential); the review fingerprint (materialized request, diff,
   semantic diff, resolved basis, warnings, consequence class, expected
   outputs — a basis observation's changed statement makes the proposal
   stale even with an identical mutation diff; an unrelated change only
   advances `lastValidatedRevision`, `createdAgainstRevision` is
   immutable); the separate proposal ledger (memory + localStorage, an
   unreadable ledger is never emptied); `ModelService.saveIfRevision`
   over the repositories' synchronous compare-and-write; the two-phase
   approval (ledger applying with expected base + result revisions ->
   guarded save -> ledger applied; stale / conflict / persistence
   failure write nothing) and startup recovery of `applying` proposals
   (current == expected result -> reconciled applied; current == base ->
   commit never landed; otherwise recovery conflict).
   KERNEL STEP 2 DONE (the human review experience): `/proposals` is the
   review inbox for the active system (Needs your review: proposed /
   stale / failed; Reviewed — ready for your decision; History). The
   review card (`src/components/proposal-card.tsx`, wording from the
   pure `src/kernel/wording.ts`) answers what is being proposed, why,
   what will change, what else will change, what will not change
   ("Nothing else changes." only when the diff proves it), what records
   it is based on (always followed by "These records explain why this
   proposal was made. They do not make the proposal true."), and what
   uncertainty remains; the mechanical diff sits under Details. Ordinary
   proposals approve in one explicit step after "I have reviewed this";
   consequential ones need a second confirmation that NAMES the
   consequence (no default approval, timers, prechecked boxes or
   approve-all). A stale card shows what you reviewed before, what
   changed since then (cited records' old and new wording included) and
   what the proposal would do now; approval is unavailable until "I have
   reviewed the new version". Two state corrections: the unused
   `approved` status is removed (proposed -> reviewed -> applying ->
   applied), and `failed` leaves ONLY through the explicit
   `ProposalService.retry` ("Check again and retry": reviewed again when
   the review material is unchanged, stale when it changed; the kernel
   never retries on its own). The provider exposes the kernel over the
   same service and store, runs startup recovery before any card can act
   (outcomes surfaced in a "Recovered on startup" card; an unreadable
   ledger is reported and never emptied), and `approveProposal` ADOPTS the
   model returned by the guarded save as React state without saving it
   again — on any failure React state does not change. A person proposes
   through the same kernel with the "Propose a change" form (registered
   kind + JSON arguments, rationale, cited observations, own words); Edit
   reuses it and supersedes. Verified in Chromium: ordinary approve (one
   store write, two ledger writes), consequential double confirmation,
   reject, edit, stale -> re-review -> approve, failed persistence ->
   displayed model unchanged -> explicit retry, startup recovery
   (never-landed and conflict), unreadable ledger.
   KERNEL STEP 3 DONE — hypothesis confidence may be NOT ASSESSED (schema
   v6, migration `migrateV5toV6`): `Hypothesis.confidence` is
   `unitInterval.nullable().default(null)`; null is not zero and is never
   read as low; the migration preserves every valid v5 number exactly
   (0.5 stays 0.5 — a deliberate 0.5 cannot be told from the old default)
   and enforces the v5 contract first, refusing missing / null / string /
   out-of-range confidence as corrupt v5 data through the ordinary
   refusal discipline (nothing stored, no backup, original byte-identical,
   importer writes nothing); `HypothesisInput.confidence` is optional or
   null and `addHypothesis` / `ensureLoopHypothesis` store null unless a
   judgment is explicitly supplied; the hypotheses form starts at "Not
   assessed" (empty percent field, no slider, explicit clear), existing
   numbers open exactly as stored, and null renders as "Not assessed"
   through a hypothesis-specific badge; the proposal kernel's
   addHypothesis requires only the statement and previews "Confidence:
   not assessed."; a reviewed proposal created under v5 revalidates
   harmlessly after the model migrates. No calculation reads the field
   (pinned by source scan and by evaluation equality). STORAGE SAFETY CHECKPOINT 3.1 DONE
   (unreadable != empty): the repository refuses a present-but-unreadable
   store envelope (bad JSON, not an object, malformed models / backups /
   activeId) with a typed `StorageError` on every read and write and
   never normalizes it; a raw model record that fails migration still
   counts as stored (`hasStoredModels`, `unreadable`), so
   `loadActiveOrSeed` seeds only when NO raw record exists — an
   unreadable record under the seed's own id or any other id is reported
   and preserved byte for byte, never replaced by the sample, and `save`
   (reset-to-sample included) refuses to overwrite it while a valid
   sibling still loads; the legacy single-model key is imported only when
   it parses, has a usable id and collides with nothing, the primary
   write lands first and the key is removed only afterwards, a failed
   import leaving the legacy bytes intact; every page shows the storage
   notice instead of an endless load. Explicit recovery / export /
   deletion of unreadable data is a later tool. 3.1.1 hardenings: an empty
   string under either key is present malformed data (refused, kept),
   never an absent key; the guarded `saveIfRevision` refuses an unreadable
   raw record explicitly before any revision compare (a caller passing
   any expected revision, the old synthetic one included, cannot
   overwrite it); page-level Loading is suppressed under a storage
   error. KERNEL STEP 4 DONE —
   Explore -> Investigate -> proposal -> review -> approved hypothesis:
   "Investigate this explanation" now creates ONE `addHypothesis` proposal
   (the draft's words, the pattern's subject, confidence null; nothing
   else invented, the Explore locus not written) through the kernel and
   sends the person to `/proposals?focus=<id>`; only approval there
   creates the hypothesis (status proposed, confidence not assessed).
   The proposal's basis is RE-RESOLVABLE: `pattern` (occurrence times),
   `cross_context` (the SAME deterministic `crossContext` rerun under
   `contextSubjectsFor` for the model's current domain — the whole result
   is the content, so the occurrence set, contrast set, every condition's
   readings and classification, coverage, unresolved groups and nearby
   events all take part in the review fingerprint), `user_statement`,
   and `catalogue_prompt` (domain id/version + prompt id resolved to the
   current question, the reviewed wording kept as a snapshot). A stale
   card names what moved (a changed cited record, a condition whose
   reading or classification changed, a reading at one occurrence or
   contrast time, changed nearby events). Drafts carry `proposalId` so a
   repeated click opens the review instead of creating a duplicate; on
   return, open proposals stay linked, superseded ones follow their
   replacement, applied and rejected ones release the draft. Hypotheses
   created from a pattern are surfaced from the ledger's provenance
   ("Created from this Explore pattern"), merged with model-linked ones,
   never by wording. Source pins: Explore imports no mutation function
   and no service save/apply path. STEP 5A (design, on file in the
   session record) redefined the AI boundary: AI interprets, never
   calculates; explicit epistemic states instead of invented numbers;
   deterministic, inspectable, task-scoped context; AI output becomes a
   proposal only through the kernel. STEP 5B DONE — AI CONTEXT BUILDER +
   LEGACY WRITE SHUTDOWN: `src/ai/context.ts` builds
   `buildAiContext(model, task, selection)` for six tasks
   (extract_statements, interpret_free_text,
   suggest_explanations_for_pattern, suggest_questions_to_reduce_uncertainty,
   summarize_model, propose_observation_from_user_statement), each with an
   explicit allowlist of item kinds and a subject-scope rule (subject +
   system; the pattern's `contextSubjectsFor` scope; or the selected
   subjects); typed `ContextRef`s with a canonical string id for display;
   every value carries its basis (recorded_here / carried_forward /
   calculated / explicit_unknown / ambiguous / unknown) and stored
   judgments are labelled as judgments; the Explore task reuses PatternRef,
   contextSubjectsFor and crossContext verbatim; the manifest lists what
   was included, which subjects were excluded and why, the standing
   exclusions (notes, evidence text, superseded entries, the ledger,
   browser drafts) and domain-configured sensitive items withheld unless
   explicitly included; `contextHash` covers task, system id, a digest of
   the kernel revision, items and manifest, never `builtAt`, and "values
   as of" is explicit content (a task that carries values refuses to
   default it from the clock). Epistemic vocabulary fixed for the later
   output contract: directly_stated / interpretive / tentative /
   unresolved, never mapped to numbers. `AiCallIdentity` (task,
   contextHash, revisionHash) is the handle a future AI-output basis will
   use so content origin stays separate from ProposalAuthor. The legacy
   /ai screen is READ-ONLY (no mutation import, no apply, no ai_inferred
   stamping, the old candidate schema not routed into proposals) and shows
   the "What would be sent to AI" panel. RECORDED BLOCKERS (canonical
   seams, not AI-screen bugs): (1) `addVariable` manufactures
   controllability / durability / estimatedCostToChange 0.5 and an initial
   value with sourceType unknown and confidence 0 when omitted — AI ->
   Variable stays prohibited until that mutation contract is cleaned; (2)
   `addObservation` requires a numeric confidence — AI -> Observation
   stays blocked until its confidence semantics are deliberately resolved,
   never by making a person invent a number. STEP 5C DONE — TRANSPORT BOUNDARY +
   STRICT AI OUTPUT CONTRACT + TASK MOCK. Three identities, never
   conflated: `sourceRevisionHash` (which local model state the context
   came from; LOCAL audit only), `contextHash` = hash(canonical(
   `providerPayload`)) where the provider payload is task + items and
   nothing else (no manifest, no exclusion bookkeeping, no revision, no
   clock; an edit to an excluded subject or to a note changes the source
   revision but not the payload or the hash), and (later) the AI output
   item id. SENSITIVITY IS TRANSITIVE through one decision: a sensitive
   variable is withheld directly and through every composite that carries
   it (derived formulas reading it, relationships naming it, the pattern,
   the whole Explore comparison when any condition, context reading or
   nearby event is sensitive, hypotheses and observations linking it);
   composites are withheld WHOLE, never trimmed, and the manifest says so
   ("Explore comparison withheld because it contains sensitive context");
   explicit `includeSensitive` sends the complete item unchanged. The new
   contract (`src/ai/response.ts`) is strict and task-enveloped:
   Extraction (verbatim quote of a cited textual source, always
   directly_stated = the source says it, not that it is true),
   Interpretation and CandidateExplanation (interpretive / tentative /
   unresolved only; no cause, proof or odds claims; `forPattern` must be a
   supplied pattern item), Question (targets, why it matters; no gain
   ranking), Summary (every section cites supplied refs); unknown keys,
   a contextHash mismatch, an uncited ref, a paraphrased quote, a
   disallowed kind or a forbidden claim rejects the WHOLE response; the
   schema declares no confidence, probability, odds, strength, lag or
   information-gain field. `AiTaskProvider.run(payload, contextHash)` is
   the seam; `MockAiTaskProvider` answers each task deterministically with
   neutral wording and validates its own output. The /ai screen renders
   the provider payload literally, the manifest separately as "What was
   intentionally left out", and the mock's validated output under "Mock
   interpretation — nothing will be added to your model"; the legacy
   analysis is collapsed. STEP 5D DONE — VALIDATED AI OUTPUT ->
   HUMAN-INITIATED PROPOSAL. Extraction lost `subjectRef` (the subject is
   derived from the cited source; the AI never assigns it). The kernel
   gains an immutable `ai_output` ORIGIN basis (adapter, task,
   contextHash, sourceRevisionHash, output item id and kind, text, state)
   that resolves to its own snapshot and is worded on the card as "AI
   wording that prompted this proposal … The AI output is not evidence.
   The cited records below are the basis for reviewing the proposal.";
   provider payload, manifest and withheld material never enter the
   ledger. The pure bridge `toProposalSet(context, response, adapterId)`
   (src/ai/proposal-bridge.ts; imports no repository or service) maps a
   validated CandidateExplanation — and nothing else in 5D — to exactly
   one registered `addHypothesis` (the AI's words, the PATTERN's subject,
   confidence null; no status, prediction, evidence attachment, condition,
   kill criterion, relationship or notes; weakenedBy / alternatives stay
   prose), with the evidence basis pattern + Explore comparison + every
   cited item converted to its exact kernel basis kind (observation,
   event, hypothesis, relationship, variable, catalogue_prompt, user
   statement); a cited kind with no re-resolvable basis (system, value,
   derived, constraint) fails the WHOLE set visibly, never snapshotted.
   CONTENT ORIGIN != PROPOSAL AUTHOR: the person clicks "Review as
   hypothesis", so `proposedBy` is the person and the ai_output basis
   records the origin; Step 4 staleness holds unchanged (a changed
   comparison or recurrence goes stale with identical AI wording, an
   unrelated change revalidates harmlessly). Duplicate protection:
   adapterId + contextHash + outputItemId identifies a suggestion; an
   open proposal is navigated to, an applied one reads "Already added as
   a working hypothesis", a rejected one is shown and never recreated
   from the identical output. /ai reads a pattern from its URL (Explore
   links "Ask about this pattern"), and the other 5C output kinds remain
   display-only (Observation and Variable stay blocked by the recorded
   canonical seams; free-text interpretations may cite value/derived
   kinds the kernel cannot re-resolve). PAUSED by decision: 5E (Explore
   AI drafts) and 5F (first external provider) wait; the next work is the
   simplified product experience over this machinery.
5. Home / Map / History / Library shell with the mock adapter: Source
   records, capture box, deterministic "What I'm seeing", the four-place
   navigation, existing screens re-homed under Library and Details.
   STEP 6A DONE — SIMPLIFIED PRODUCT SHELL + HOME (the shell and Home
   only; History, Explore and Review keep their current screens pending
   visual review). Primary navigation is exactly Home / History / Map /
   Library (src/components/nav.tsx; the side navigation is gone, the
   main column is wider, the as-of pill persists in the top bar). No
   route was deleted: the old dashboard moved from `/` to `/overview`
   unchanged, `/map` wraps the existing feedback-map page, `/library`
   is the advanced index grouped Records / Model / Investigation /
   Advanced analysis and hosts the system switcher, and every existing
   route is linked from it (pinned by tests/architecture/shell.test.ts,
   which also pins the four labels, the Home wording, and that Home
   imports no mutation, apply, save or proposal-creating path). HOME
   (src/app/page.tsx) opens with "What are you thinking about?", a large
   capture box ("Write what's on your mind. You don't need to organize
   it first."), a reserved microphone glyph that records nothing, and a
   draft kept ONLY in this browser (`human-systems.home-draft.v1`, keyed
   by system; it is not a Source record — Source capture is still the
   roadmap item above). The one primary action, "Reflection demo", runs
   the deterministic MockAiTaskProvider read-only over the
   interpret_free_text context and is labelled "nothing is added to your
   notebook" / "a deterministic stand-in, not real intelligence". Cards
   come only from systems that already exist (src/features/home/cards.ts,
   pure, generic): "Something keeps showing up" = describeVariableHistory
   over each assigned input's recorded span up to today, exact
   repetition only, worded by historySentenceFor, strongest first, three
   at most, each with the exact Explore pattern hand-off; "Needs your
   review" = the ledger's open count (proposed / reviewed / stale /
   failed / applying) linking to /proposals; "Working explanations" =
   non-rejected hypotheses. Empty states are calm sentences. Home uses
   no engine vocabulary (no structural gap, attractor, model health,
   variables, recurrence set, cross-context). Storage errors, the as-of
   notice with "Back to today", and the unreadable-store warning render
   unchanged. The stale "no model write, no proposal" sentence on /ai
   now says a candidate explanation can be sent to review as a proposal.
   Discovery math, proposal semantics and canonical schemas are
   untouched; 5E/5F remain paused.
   STEP 6A.1 DONE — VISUAL CONVERGENCE FROM THE REVIEWED HOME
   SCREENSHOTS (the four-place shell is approved and frozen; engines,
   proposal semantics, AI contracts, History/Explore math, schemas and
   navigation architecture untouched). The hierarchy is now: write
   first, one thing worth noticing, anything requiring a decision. The
   capture surface is the unmistakable first focus in the narrow
   notebook column: no microphone until voice input exists, no resize
   handle (the textarea auto-grows from a comfortable minimum), and no
   disabled button — "Reflect on this" with a small Demo badge appears
   only after the person types, captioned "Demo response · nothing is
   saved to your notebook." The fictional-sample note moved to the quiet
   context line at the bottom with the Library link. The as-of pill and
   the Home banner were consolidated into ONE slim strip under the
   primary navigation on every page (`AsOfStrip`: "Viewing June 1, 2025 ·
   Back to today"); no page shows two as-of notices; storage errors keep
   their prominent notice. Home shows at most ONE recurrence, the
   strongest, worded by a Home-specific formatter over the same engine
   facts (`recurrenceSentence` / `homeQuantity` in
   src/features/home/cards.ts: "Total debt was $4,000 on 7 recorded
   dates between February 2025 and June 2026."; currency leads with the
   sign, placeholder units vanish) with "Explore what was happening →",
   then a quiet "N more patterns in History →"; the History engine's
   sentence and its record / application-time counts stay in History and
   Details. Empty states render nothing; the review card renders only
   with open proposals; working explanations are a compact flat line
   ("You're investigating 4 explanations", one truncated example, "View
   all →"). Labels are sentence case; muted text is darker
   (`--muted: #4d5966`) with relaxed line-height; cards carry a subtle
   border and no shadow. Pinned by tests/architecture/shell.test.ts and
   tests/features/home-cards.test.ts; Chromium desktop + mobile verified
   no horizontal overflow, one as-of notice, no microphone, no empty
   cards, one recurrence card with "$4,000", the more-patterns link to
   History, the actionable proposal card, and every primary destination
   plus Library reachable. Reviewed: yes, one would sit down and type
   into it.
   STEP 6A.1.1 DONE — FINAL HOME FREEZE (layout approved from the
   reviewed screenshots and preserved exactly: column width, whitespace,
   navigation, auto-growing writing surface, one recurrence card, flat
   working-explanations line, conditional review card, typography). Four
   corrections only. (1) The global strip says "Values as of June 1,
   2025 · Back to today", not "Viewing …": asOf resolves values
   historically; relationships, hypotheses and constraints remain
   today's structure, so a whole-model snapshot must never be implied.
   Still exactly one as-of treatment. (2) The Home reflection is bound
   to its context exactly as the /ai screen binds the mock:
   src/features/home/reflection.ts builds the current
   interpret_free_text context from the model, the draft and the as-of
   selection (`homeContext`) and `visibleReflection` renders a stored
   {forHash, result} only while forHash equals the current contextHash;
   a changed date, a changed relevant value or changed text hides the
   old response and nothing reruns the mock (tests/features/
   home-reflection.test.ts pins all four cases with the real builder and
   provider; Chromium pins reflect → Back to today → hidden). (3) The
   demo response is humanized: the interpretation is the paragraph
   itself (no "A tentative reading:" prefix), its caveat sits under it,
   questions carry the quiet heading "Question to consider"; no
   epistemic or debug vocabulary appears on Home and the output schema
   is untouched. (4) The footer reads "Fictional sample · Your systems
   and advanced details are in Library." HOME IS FROZEN: no further
   polishing unless a usability test reveals a concrete problem. The
   product's visual language is set — Home is for thinking, History for
   remembering what changed, Explore for asking why, Library for the
   machinery — and the next step is History, then Explore, Review, Map.
   STEP 6B DONE — HISTORY: SIMPLIFY THE PRESENTATION, NOT THE
   DISTINCTIONS. The discovery engine (src/discovery) is untouched: the
   same describeInterval call, the same buckets, the same occurrence
   times, and "Explore what was happening" hands /explore the EXACT
   PatternRef the original screen encoded (variable, subject, requested
   interval, repeated value, occurrence times — pinned byte for byte in
   tests/features/history-wording.test.ts). The first layer now reads as
   three ordinary questions in the narrow notebook column: "What
   changed?" (values that ranged, plus events), "What keeps showing up?"
   (exact repetition one row PER REPEATED VALUE with its own Explore
   hand-off, tag "Same value"; low recorded variation "Stayed close"; an
   explicitly stated period "As stated" — the non-exact kinds keep the
   read-only "Look closer" card), and "What still needs more
   information?" (tags "Old value still standing", "Not enough history",
   "Unknown", plus events without a date; grouped by distinction, a group
   above three rows collapses to one sentence with "Show all N" — nothing
   dropped). Wording lives in src/features/history/wording.ts over the
   shared src/features/plain-language.ts ("Total debt ranged from $4,000
   to $9,500 across 8 recorded values between February 2025 and
   September 2026."; "Total debt was $4,000 on 7 recorded dates …");
   forbidden phrases are checked on every generated sentence. Behind
   toggles: Change period (From / To / Whose records), Advanced (the A23
   low-variation display convention, calculated values recomputed under
   today's structure, saved snapshots), Details on every row (the
   engine's own sentence and evidence lines, the raw records with source
   and confidence, resolution at both ends, evidence facts) and "Notes on
   this period" (the interval caveats); the causation disclaimer stays
   on the page. Nothing writes to the model. Chromium desktop + mobile:
   three headings in order, the first layer free of A23 / application
   times / dated records / evidence facts / confidence wording, the
   Explore hand-off opening the pattern, Change period and Advanced
   revealing their controls, Details revealing the records table
   (scrolling inside its own box on mobile), no horizontal overflow.
   STEP 6B.1 DONE — HISTORY FIRST-LAYER CLEANUP (presentation only;
   discovery, buckets, PatternRef, URL parsing, Details, Advanced
   behaviour and grouping untouched). The visible period header is the
   period, whose records, Change period and Advanced — the engineering
   counts ("N recorded variables, N dated values and N events") render
   only inside Advanced. A change reads "Total debt ranged from $4,000 to
   $9,500 between February 2025 and September 2026." and a close range
   "Liquid reserves stayed between $2,000 and $2,400 between …" — no
   "across N recorded values"; the counts stay in Details through the
   engine's own sentence and the records table. Counts remain in the
   first layer only where the finding needs them: an exact repetition's
   "on 7 recorded dates" and "only one recorded value". Exact-repetition
   rows carry no "Same value" tag (the section and the sentence already
   say it); Stayed close, As stated, Old value still standing, Not enough
   history and Unknown keep their tags because they mean different
   things. Pinned in tests (first layer free of recorded variable / dated
   value / across N recorded values / Same value; Details still exposes
   the counts and raw records) and in Chromium. HISTORY FROZEN at
   e5e0e68 (reviewed: the removal of cards was right; event timing
   wording — "2025-07-01", "Mar–Aug 2026 (two months within)" — is on
   the polish backlog, not a checkpoint).
   STEP 6C DONE — EXPLORE: SIMPLIFY WITHOUT CHANGING THE COMPARISON.
   Unchanged: crossContext and contextSubjectsFor (the same call, pinned
   verbatim), PatternRef, occurrence/contrast membership, condition
   classifications, contrast coverage, event scope, the draft scope key
   (`${model.id}|${encodePatternRef(pattern)}` under
   human-systems.explore-drafts.v1), promptId capture, proposal basis and
   request (buildExploreProposal -> ProposalService.create with
   proposedBy person -> /proposals?focus=id), staleness, hypothesis
   linking, AI contracts, schemas. The page now reads in the notebook
   column: "← Back to History / Explore / This kept happening. Why might
   that be?" then the pattern in plain words from the result only
   ("Total debt was $4,000 on 7 recorded dates between …") with "See the
   recorded times" hiding every occurrence and contrast date, marker,
   nearby event and the event-window convention until asked. Five
   questions follow, worded by src/features/explore/wording.ts over the
   engine's own groups row by row (tests/features/explore-wording.test.ts
   pins identical ids and order per group, every condition exactly once,
   partial coverage under unresolved): What was different each time?
   ("Liquid reserves was $2,000, then $4,500, then …"); What was the same
   each time? ("X was 3 months each time."); How did the other recorded
   times compare? — only the complete-coverage groups, each rendered only
   when it has entries, translated without changing meaning ("Also true
   when this did not happen" / "Different when this did not happen" /
   "Mixed in the other recorded times"; a differentiating row reads
   "different in all of the recorded comparison cases", never caused /
   explains / strong evidence / likely cause / predictor; no contrast
   cases -> "There are no other recorded values to compare with yet.");
   What is still unresolved? (tags "Not readable at every time", "No
   usable comparison", "Comparison incomplete"; the five unresolved
   meanings stay distinct; a group above three rows collapses to one
   sentence with "Show all N"); What might explain this? — one human
   workspace: "Already investigating" only when a linked or created
   hypothesis exists ("Created from this pattern" where applicable;
   status, confidence and the exact link reasons under Details), the
   person's drafts with their domain locus label (Person / Environment /
   Interaction), "Investigate this explanation" as the one primary
   action, a plain proposal status ("Waiting for your review", "Needs a
   fresh review …", "Could not be applied …", "Replaced …", never hidden)
   with "Review proposal →", "Write an explanation" opening "Your
   explanation" + a locus choice + "Keep as draft" / Cancel / "Draft only
   · kept in this browser", every domain prompt under one collapsed
   "Questions to help you think" (locus label kept; selecting one still
   creates a draft with that exact promptId), and the mock AI link
   demoted to "Help me think about this pattern · Demo". Footer: "These
   comparisons can help you form explanations. They do not establish a
   cause." with "About this comparison" holding the carried-forward
   rule, the complete-coverage rule, the five unresolved meanings, the
   draft-is-not-evidence line and every engine caveat. Each condition
   row's Details shows the engine's own statement and its readable /
   same / different counts. No Card components, no six equal blocks, no
   empty locus sections, no "No candidate yet". Chromium desktop +
   mobile: History -> exact recurrence -> Explore, plain first layer,
   recorded times hidden until requested, complete groups keep their
   meanings, incomplete coverage stays unresolved, write a draft from a
   question -> reload -> survives with its promptId, Investigate -> model
   unchanged -> focused proposal with proposedBy person and the
   pattern / cross_context / catalogue_prompt / user_statement basis,
   return -> "Waiting for your review" + "Review proposal", approve ->
   "Already investigating" + "Created from this pattern" with confidence
   only under Details, no horizontal overflow, the first mobile viewport
   showing the pattern and the first question. EXPLORE FROZEN at f1b6e31
   (polish backlog, not a checkpoint: a colon form "Liquid reserves:
   $2,000 → $4,500 → …" for the differed-each-time row; the expanded
   recorded-times detail is intentionally technical).
   STEP 6D DONE — REVIEW: SIMPLIFY WITHOUT CHANGING APPROVAL SEMANTICS.
   The proposal kernel is frozen and untouched (create, materialization,
   dry-run, fingerprints, revalidation, staleness, review status,
   approval, guarded persistence, retry, rejection, superseding,
   recovery, consequential classification); the page still acts only
   after startup recovery, still revalidates every reviewable proposal
   through the kernel, and still approves only through the provider's
   guarded approveProposal. The human concept is now "Review — Nothing
   changes until you decide." at the same /proposals route: a focused
   proposal (?focus=id from Explore) first in one subtle bordered
   surface, other actionable proposals under "Other things waiting for
   you", no empty inbox sections, applied / rejected / superseded under
   a collapsed "Past decisions (N)", and the manual composer preserved
   unchanged under a collapsed "Advanced" near the bottom. The card
   (src/components/proposal-card.tsx over src/features/review/wording.ts)
   answers four questions first over the kernel's own describeProposal()
   wording: what am I deciding ("Keep this as a working hypothesis?" +
   the quoted statement when the single registered step is
   addHypothesis; otherwise "Apply this change?" + the kernel's first
   summary), "What this would change" (willChange), "Why you're seeing
   this" (why), "Based on" (the kernel's basis lines with human labels —
   You wrote / Pattern / Comparison / Question / Suggested wording /
   Record / Event / Hypothesis / Variable / Relationship / Value history
   — never ai_output, cross_context, PatternRef, fingerprint or
   basis-kind names; AI wording carries the not-evidence note; the basis
   disclaimer stays visible), and "Still uncertain" only when a
   proposal-specific line exists (the kernel's fixed cannot-judge
   sentence moves under Details). One primary action per state and the
   decision stays two-stage: proposed -> "I've reviewed this"
   (ProposalService.review, never approval); reviewed -> "Ready for your
   decision" + "Approve and apply" (guarded path); stale -> "Something
   changed since you reviewed this" with changedSince prominent, the
   current form, "What you reviewed before" under Details, and "I've
   reviewed the updated version" before approval is possible; failed ->
   "Nothing was written." + "Check again and retry" (explicit, never
   automatic). A consequential proposal names its consequence up front
   and still requires "Yes, apply this consequential change" (cancel is
   "Cancel"; Reject is never renamed — it is a persisted decision). Reject
   and Edit stay secondary; the note is revealed by "Add a note". Under
   Details, nothing removed: author, timestamps, ordinary/consequential
   label, id, status word, what else will change, what will not, every
   uncertainty line, named consequences, what was reviewed before, the
   mechanical diff. Recovery outcomes are translated but all three stay
   named (already saved / never reached your notebook / neither before
   nor after — fresh look) and an unreadable ledger is still reported.
   Pinned in tests/features/review-wording.test.ts and
   tests/architecture/shell.test.ts (state -> action mapping, canApprove,
   the second confirmation, no timers / prechecked / approve-all, no
   model save or mutation import, no "Not now"); Chromium desktop +
   mobile walked Explore -> Investigate -> focused Review with the
   decision in the first viewport and the model unchanged -> reviewed ->
   Approve and apply -> canonical hypothesis (confidence null, subject
   the pattern's) -> Past decisions; stale (changed-since first, approval
   unavailable, re-review, approval available); reject (model unchanged,
   note kept, Past decisions); consequential (named before review, no
   one-step approve, explicit second confirmation); failed ("Nothing was
   written.", retry only, then applied); edit -> supersede; startup
   recovery line; unreadable ledger; no horizontal overflow on mobile.
   STEP 6D.1 DONE — FINAL REVIEW POLISH FROM THE SCREENSHOT AUDIT
   (presentation only; kernel untouched; layout, two-stage flow,
   state actions, second confirmation, stale, retry, recovery gating,
   Details, diff and composer preserved). (1) Review is not Library:
   /proposals is excluded from the Library catch-all, so no primary tab
   is active there. (2) Generic wording means CHANGE: the lede is "Check
   what would change before anything changes in your notebook. Nothing
   changes until you decide." and the generic applied state is "Change
   applied" (hypothesis wording unchanged). (3) The recovery CONFLICT
   line no longer says nothing was written — "Your notebook no longer
   matches either the state before this change or the state this change
   expected to produce. It needs a fresh look before any retry." — while
   commit_never_landed still may. (4) Explore-origin basis is worded in
   product language on the first layer from the ALREADY-RESOLVED content
   only (src/features/review/wording.ts basisRows(lines, resolvedBasis):
   the pattern from its current occurrence times and the comparison's
   variable name and unit — "Total debt was $4,000 on 7 recorded dates
   between …"; the comparison from its counts — "7 repeated times were
   compared with 1 other recorded time. 1 condition differed across the
   repeated times; 0 were recorded the same every time; 22 conditions
   are still unresolved." — no recomputation, no ranking, no cause; an
   unresolved line keeps the kernel's sentence); the raw kernel pattern
   and comparison lines stay under Details ("Records cited, as the
   kernel words them"). (5) The Explore rationale reads "You chose to
   investigate this explanation in Explore." only when PROVENANCE proves
   it (pattern + cross_context basis, never wording); the complete
   rationale stays under Details. (6) A single addHypothesis reads
   "Create this working hypothesis." + subject on the first layer;
   status, confidence and the disconfirming-condition state stay under
   Details ("What will change, in full"); canonical defaults untouched.
   (7) Zero basis reads "No supporting record was cited for this
   proposal." and the basis disclaimer renders only with at least one
   row. (8) Past decisions are compact rows (outcome, the decision,
   calendar date, a rejection note, Details with the full bookkeeping,
   decision trail, kernel wording, cited records and mechanical diff;
   no actions) — never a second review card. (9) A failed write shows
   "Nothing was written." and the reason once; an action-level message
   equal to the persisted note is not repeated, new retry errors still
   surface. Pinned in tests/features/review-wording.test.ts and
   tests/architecture/shell.test.ts; Chromium desktop + mobile
   re-walked every flow with the new checks. REVIEW IS FROZEN at this
   commit unless a real usability test exposes a concrete problem.
   STEP 6E DONE — MAP: SIMPLIFY WITHOUT CHANGING RELATIONSHIP OR LOOP
   SEMANTICS. Unchanged: relationship schema and kinds, loop detection,
   dynamics eligibility, direction, strength, lag, confidence, enabled
   state, participatesInDynamics, evaluateSystem, every mutation and
   canonical storage; the editor is NOT routed through the proposal
   kernel in this step. The page (src/app/feedback-map/page.tsx, wrapped
   by /map) now opens with "Map — See what seems connected in your
   system." and one epistemic sentence ("Connections are recorded
   relationships and working hypotheses. The map does not prove that one
   thing causes another."), then the SAME NetworkDiagram over the same
   evaluated variables and allRelationships (node click, connection
   click, loop highlighting, enabled/disabled and kind/dynamics
   distinction, direction, lag labels, keyboard access all kept; lag
   labels hidden only under 480px for readability) with one reading hint;
   no stat boxes, no editor, no table above it. Wording lives in
   src/features/map/wording.ts (KIND_LABELS maps the exact enum —
   Causal hypothesis / Association / Defined relationship / Constraint /
   Not classified yet; the connection sentence follows the stored
   direction — "When X rises, Y is recorded as tending to rise/fall.";
   "causes" appears only to name a recorded causal hypothesis as a
   hypothesis) and the highlight rule in src/features/map/selection.ts
   (the original feedback map's rule, pinned). Selecting a variable shows
   "Connected with X" in ordinary language; selecting a connection shows
   a read-only summary first (kind, direction sentence, explanation, lag,
   use note) with strength (explicitly a person-entered judgment),
   confidence, source, dynamics participation, enabled state, linked
   observations, notes and the stored kind under Details, and "Edit
   connection" opening the existing RelationshipEditor (same
   useModel().apply + canonical mutations). "Feedback patterns" lists the
   engine's loops exactly (chain "A → B → C → back to A" + Reinforcing /
   Balancing feedback pattern), selection highlights the same loop nodes
   and edges, and the full LoopList entry (polarity, hypothesis status,
   mean strength, pressure, cycle time, slowest horizon, minimum
   confidence, per-edge lags, linked observations, notes) sits under
   Details. "Edit map" (collapsed) keeps New relationship, Connect on
   diagram, the unclassified filter, the editor and the complete
   relationships table with enable/disable; "About this map" (collapsed)
   holds the five counts read from the evaluation and the full legend.
   Unclassified connections get one compact line ("N connections still
   need classification, so they are not included in feedback patterns.
   Review connections →" opens Edit map with the existing filter); an
   orphaned connection stays a visible warning above the map with its
   Remove action. BACKLOG (recorded, not changed): defaultRelationshipDraft
   still initialises strength 0.5 and confidence 0.5 — AI must not rely
   on those defaults; a later epistemic cleanup decides whether "not
   assessed" belongs in these canonical fields. Pinned in
   tests/features/map-wording.test.ts (labels = the exact enum, direction
   sentences, counts read not recounted, loop ids / polarity / edgeIds /
   variableIds, the highlight rule for loop / variable / connection
   selection, the unclassified and orphan predicates) and
   tests/architecture/shell.test.ts; Chromium desktop + mobile walked map
   first with no stats/editor/table wall, variable -> connections in plain
   words, connection -> read-only summary -> Details -> Edit connection
   -> the existing editor saving only the edited field, Edit map with New
   relationship / Connect on diagram / the table, a new unclassified
   connection -> notice -> filter with loops unchanged, a feedback pattern
   selected and its Details intact, the orphan warning visible above the
   map, no page overflow with the map panning inside its own box.
   STEP 6E.1 DONE — FINAL MAP USABILITY POLISH (presentation only; graph,
   relationship model, loop detection, editor, mutation paths and the
   feedback-pattern presentation unchanged). The full technical legend
   left the primary surface: NetworkDiagram gained `showLegend`
   (default true) and an exported `NetworkLegend`; /map renders the
   diagram with the legend off and keeps one short reading hint ("Blue
   and amber arrows show the recorded direction of connections. Muted
   connections are not being used in feedback patterns.") plus, on
   narrow screens only, "Swipe sideways to explore the map."; the
   complete legend now renders under About this map, so nothing is
   lost. Explicit cross-section actions bring their result into view
   through refs and a requestAnimationFrame scrollIntoView (a
   just-opened section exists first): Show on map selects the same loop
   and scrolls to the map; Edit connection opens the same editor and
   scrolls to Edit map; Review connections opens Edit map with the same
   unclassified filter and scrolls there; Connect on diagram starts the
   same connect mode and scrolls to the map. Passive state changes
   (node click, connection click, loop Details) never scroll; selection
   semantics are unchanged. Pinned in tests/architecture/shell.test.ts
   and tests/features/map-wording.test.ts; Chromium desktop + mobile
   verified no full legend on the map, the full legend under About, the
   swipe hint on mobile only, each of the four actions landing its
   target in the viewport with the same state, no page overflow and the
   map still panning inside its own box. MAP IS FROZEN at this commit.
   The screen-by-screen redesign ends here; next is a whole-product
   usability pass across Home, History, Explore, Review and Map (wording
   mismatches, navigation dead ends, repeated concepts, empty-state
   inconsistencies, mobile continuity) — not 5E/5F, not Library, not
   another subsystem.
   STEP 6F DONE — WHOLE-PRODUCT USABILITY AND LANGUAGE PASS (audit of
   the frozen screens as one product; no screen redesigned; engines,
   discovery, cross-context, proposal semantics, kernel, schemas, AI
   contracts, mutations, loop detection and map semantics untouched).
   Method: a Chromium crawl of every primary route captured headings,
   ledes, links, buttons, active tabs and empty states; then two full
   journeys (desktop 1200px, mobile 390px) walked Home -> History ->
   Explore -> AI demo -> Explore -> Investigate -> Review -> back to the
   pattern -> approve -> Explore ("Already investigating") -> Home ->
   all explanations -> Map (variable, connection, Details, Edit) ->
   Library -> Overview -> Home, then set an as-of date and compared Home
   with History. Six cross-screen inconsistencies were found and fixed:
   (1) Home's "N more patterns in History" counted patterns per variable
   while History lists one row per repeated value, so the promise did
   not match the page — Home now counts the way History lists (pinned:
   History repeated rows = Home's N + 1). (2) With "Values as of" set,
   Home limited its patterns to that date but History's default period
   still ended today, so the strip meant different things on adjacent
   screens — History's default period now ends at the as-of date (the
   URL period still wins), and the counts agree again under as-of.
   (3) Review had no way back to the pattern an Explore-created
   proposal came from — an Explore-origin card now carries "Open the
   pattern in Explore →" built from its own pattern basis (pinned to
   encode exactly what Explore reads). (4) The AI demo reached from
   Explore ("Help me think about this pattern") had no way back and
   called the decision screen "Proposals" — it now has "← Back to
   Explore" for the same pattern and says Review. (5) Library named the
   decision screen "Proposals — changes waiting for your review" and
   Map "relationships and loops" — now "Review — decisions waiting for
   you" and "Map — connections and feedback patterns", matching the
   screens they open. (6) Home's "View all →" landed on the dense
   Hypotheses screen with no hint of what "all" meant — now "All
   explanations →" (same target). History's footer toggle was renamed
   "About this period" to match "About this comparison" / "About this
   map". Confirmed consistent and left alone: Review lights no primary
   tab, Explore lights History, advanced routes light Library; the
   as-of strip is the one treatment everywhere; empty states are calm
   sentences on every screen; "Details" means the technical layer on
   every screen; sample wording is "fictional sample" everywhere; the
   three causation cautions (History, Explore, Map) are contextual, not
   duplicates; no page overflows on mobile. Recorded backlog untouched:
   History event-date wording, Explore's differed-each-time colon form,
   Review's "0 were recorded the same", Map node abbreviations, the
   0.5 relationship defaults. Next decision (product, not roadmap):
   real AI integration (5F) or an intentionally designed Library.
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

## 16. Product surface (APPROVED DIRECTION; the shell and Home shipped in Step 6A, the rest not implemented)

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
an evidence form or a snapshot is.

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
sentences come from fixed descriptive templates ("Housing cost: the same
value recorded on 4 dates", "Income instability: recorded in every dated
entry of the period; the months between entries are unresolved");
"substantially" and "low variation" are labelled display conventions
under Details. RESOLUTION != OBSERVATION != PERSISTENCE: a value that
still resolves because nothing replaced it is carried-forward state, never
evidence that the condition held in between, and REPETITION != STRUCTURE:
repetition is measured, structure is hypothesized from it plus other
evidence. WHAT PERSISTED? is one of the central product experiences and a
Home button:

    What persisted?            Jan 2025 — Sep 2026
    Income sources changed        4 times
    Work arrangements changed     3 times
    Monthly income varied         substantially

    Repeated or similar in the records:
    • Dependence on variable income   same condition recorded on 5 dates
                                      Jan 2025 → Aug 2026
    • Low financial buffer            4 recorded values, $1,800 → $2,100
                                      low variation under convention A23
    • Need for immediate income       stated in 6 observations

    Repeated or stable observations do not establish cause.
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
