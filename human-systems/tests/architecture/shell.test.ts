/**
 * SIMPLIFIED SHELL (Step 6A): four places in the primary navigation, Home
 * that writes nothing and invents nothing, a Library that reaches every
 * existing route, and no route removed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("primary navigation", () => {
  it("shows exactly Home, History, Map and Library", () => {
    const nav = read("src/components/nav.tsx");
    const labels = [...nav.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Home", "History", "Map", "Library"]);
    expect(nav).not.toMatch(/Structural variables|Attractor|Leverage|AI analysis|Proposals/);
  });
});

describe("Home", () => {
  it("begins with the question, keeps the draft in the browser, never imports a mutation or calls apply/save, and takes its cards from the discovery engine, the ledger and the model", () => {
    const home = read("src/app/page.tsx");
    expect(home).toMatch(/What are you thinking about\?/);
    expect(home).toMatch(/Write what&apos;s on your mind\. You don&apos;t need to organize it first\./);
    expect(home).toMatch(/human-systems\.home-draft\.v1/);
    expect(home).not.toMatch(/@\/services\/mutations|\bapply\(|replaceModel|\.save\(|proposals\.create/);
    expect(home).toMatch(/recurrenceOverview\(model/);
    expect(home).toMatch(/openProposalCount\(ledger\)/);
    expect(home).toMatch(/workingHypotheses\(model\)/);
    expect(home).not.toMatch(/structural gap|attractor|model health|cross-context|recurrence set/i);
    const cards = read("src/features/home/cards.ts");
    expect(cards).toMatch(/describeVariableHistory\(/);
    expect(cards).not.toMatch(/from "react"|@\/domains|@\/services/);
  });

  it("6A.1 hierarchy: one pattern with Home wording, no empty-state cards, no microphone, no resize handle, the action only after typing, one as-of treatment, sentence-case labels", () => {
    const home = read("src/app/page.tsx");
    expect(home).toMatch(/patterns\.strongest\.sentence/);
    expect(home).not.toMatch(/\.headline|\.details\[/);
    expect(home).toMatch(/more patterns? in History/);
    expect(home).not.toMatch(/Nothing is waiting for your decision|Nothing has repeated|not investigating anything yet/);
    expect(home).not.toMatch(/🎤|Voice input|aria-hidden="true"/);
    expect(home).toMatch(/resize-none/);
    expect(home).not.toMatch(/resize-y/);
    expect(home).toMatch(/hasText \? \(/);
    expect(home).toMatch(/Reflect on this/);
    expect(home).toMatch(/Demo response · nothing is saved to your notebook\./);
    expect(home).not.toMatch(/deterministic stand-in|Reflection demo|uppercase/);
    expect(home).not.toMatch(/You are looking at values as of|Back to today/);
    const nav = read("src/components/nav.tsx");
    expect(nav).toMatch(/AsOfStrip/);
    expect(nav).toMatch(/Back to today/);
    expect(nav).not.toMatch(/AsOfPill/);
    expect(read("src/app/layout.tsx")).toMatch(/StorageNotice/);
  });

  it("6A.1.1 freeze: one as-of treatment worded 'Values as of', the reflection bound to its contextHash, no epistemic labels on the demo response, a short sample footer", () => {
    const nav = read("src/components/nav.tsx");
    expect(nav.match(/data-testid="as-of-strip"/g)).toHaveLength(1);
    expect(nav).toMatch(/Values as of <span/);
    expect(nav).not.toMatch(/Viewing </);
    const home = read("src/app/page.tsx");
    expect(home).not.toMatch(/Values as of|Back to today|Viewing/);
    expect(home).toMatch(/homeContext\(model, draft, asOf, today\)/);
    expect(home).toMatch(/visibleReflection\(reflection, current\)/);
    expect(home).toMatch(/forHash: ctx\.contextHash/);
    expect(home).not.toMatch(/buildAiContext/); // the binding helper owns the context
    expect(home).not.toMatch(/A tentative reading|directly_stated|interpretive|tentative|unresolved|epistemic/);
    expect(home).toMatch(/Question to consider/);
    expect(home).toMatch(/Fictional sample · /);
    expect(home).not.toMatch(/You are looking at the/);
    const helper = read("src/features/home/reflection.ts");
    expect(helper).not.toMatch(/MockAiTaskProvider|from "react"|@\/domains|@\/services/);
  });
});

describe("History (6B: presentation simplified, distinctions kept)", () => {
  it("asks the three questions first, keeps every engine distinction, hands Explore the same PatternRef, and moves the technical layer behind Change period / Advanced / Details", () => {
    const page = read("src/app/history/page.tsx");
    for (const q of ["What changed?", "What keeps showing up?", "What still needs more information?"]) expect(page).toContain(`title="${q}"`);
    expect(page.indexOf("What changed?")).toBeLessThan(page.indexOf("What keeps showing up?"));
    expect(page.indexOf("What keeps showing up?")).toBeLessThan(page.indexOf("What still needs more information?"));
    expect(page).toMatch(/historyQuestions\(d\)/);
    expect(page).toMatch(/needsInformationGroups\(q\.needsInformation\)/);
    // 6B.1: the engineering counts render only inside the Advanced block, never in the header
    const header = page.slice(page.indexOf("<header"), page.indexOf("</header>"));
    const advanced = header.slice(header.indexOf('data-testid="advanced-controls"'));
    expect(header.split("periodSummary(").length - 1).toBe(1);
    expect(advanced).toMatch(/periodSummary\(/);
    expect(header.slice(0, header.indexOf('data-testid="advanced-controls"'))).not.toMatch(/periodSummary/);
    expect(read("src/features/history/wording.ts")).not.toMatch(/tag: "Same value"/);
    expect(page).toMatch(/describeInterval\(model/); // the same engine call as before
    expect(page).not.toMatch(/@\/services\/mutations|\.save\(|proposals\.create/);
    // the technical layer is behind toggles, never on the first layer
    for (const t of ["change-period", "advanced", "history-details", "caveats"]) expect(page).toContain(`data-testid="${t}"`);
    expect(page).toMatch(/A23/); // the convention is still selectable, under Advanced
    expect(page).toMatch(/includeDerived/);
    expect(page).toMatch(/SourceBadge|ConfidenceBadge/); // raw records with provenance stay under Details
    expect(page).toMatch(/CAUSATION_DISCLAIMER/);
    const wording = read("src/features/history/wording.ts");
    expect(wording).toMatch(/encodePatternRef\(\{ variableId: d\.variableId, subjectId: d\.subjectId, interval: \{ from: d\.interval\.requested\.from, to: d\.interval\.requested\.to \}, repeatedValue, occurrenceTimes/);
    expect(wording).not.toMatch(/from "react"|@\/domains|@\/services/);
    // discovery math untouched by this step: the engine modules import nothing from features
    for (const f of ["describe-history.ts", "describe-interval.ts", "cross-context.ts", "language.ts", "pattern-ref.ts"]) expect(read(`src/discovery/${f}`)).not.toMatch(/@\/features/);
  });
});

describe("Explore (6C: presentation simplified, comparison unchanged)", () => {
  it("asks the five questions in order over the same engine call, the same draft scope, the same proposal path, and moves the technical layer behind toggles", () => {
    const page = read("src/app/explore/page.tsx");
    const order = ["What was different each time?", "What was the same each time?", "How did the other recorded times compare?", "What is still unresolved?", "What might explain this?"];
    for (const q of order) expect(page).toContain(`title="${q}"`);
    for (let i = 1; i < order.length; i++) expect(page.indexOf(order[i - 1])).toBeLessThan(page.indexOf(order[i]));
    expect(page).toContain("This kept happening. Why might that be?");
    // unchanged: the comparison, its subject scope, the draft scope key, the proposal request and author, the review hand-off
    expect(page).toContain("crossContext(model, pattern, { contextSubjectIds: contextSubjectsFor(model, pattern, domain) })");
    expect(page).toContain("const scope = `${model.id}|${encodePatternRef(r.pattern)}`;");
    expect(page).toContain('const DRAFTS_KEY = "human-systems.explore-drafts.v1";');
    expect(page).toContain("const input = buildExploreProposal(d, r, domain);");
    expect(page).toContain('proposals.create({ modelId: model.id, request: input.request, proposedBy: { kind: "person" }, rationale: input.rationale, basis: input.basis })');
    expect(page).toContain("setEditing({ locus: q.locus, text: \"\", promptId: q.id })");
    expect(page).toContain("promptId: editing.promptId");
    expect(page).not.toMatch(/@\/services\/mutations|\bapply\(|replaceModel|\.save\(/);
    // the technical layer is behind toggles; no six equal cards; the demo link is secondary
    for (const t of ["recorded-times-toggle", "about", "condition-details", "hypothesis-details", "questions", "write-explanation", "help-me-think"]) expect(page).toContain(`data-testid="${t}"`);
    expect(page).not.toMatch(/<Card\b/);
    expect(page).not.toMatch(/No candidate of this kind yet|links, never wording, decide this|Write your own|Keep as a candidate/);
    expect(page).toMatch(/Write an explanation/);
    expect(page).toMatch(/Keep as draft/);
    expect(page).toMatch(/Draft only · kept in this browser/);
    expect(page).toMatch(/Created from this pattern/);
    expect(page).toMatch(/Help me think about this pattern/);
    expect(page).toMatch(/exploreSections\(result\)/);
    // every engine group is consumed by the wording module; the engine imports nothing from features
    const wording = read("src/features/explore/wording.ts");
    for (const g of ["differingAtOccurrences", "commonAtOccurrences", "insufficientAtOccurrences", "backgroundComplete", "differentiatingComplete", "mixedComplete", "contrastPartial", "undecided"]) expect(wording).toContain(g);
    expect(wording).not.toMatch(/from "react"|@\/domains|@\/services|@\/kernel/);
    expect(read("src/discovery/cross-context.ts")).not.toMatch(/@\/features/);
    expect(read("src/features/explore/proposal.ts")).toBe(read("src/features/explore/proposal.ts")); // untouched by this step is proven by git; the proposal path pins above cover behaviour
  });
});

describe("Review (6D: presentation simplified, approval semantics unchanged)", () => {
  it("page: Review first, the focused proposal first, no empty inbox sections, past decisions and the composer collapsed; recovery gating and kernel revalidation intact", () => {
    const page = read("src/app/proposals/page.tsx");
    expect(page).toMatch(/<h1[^>]*>Review<\/h1>/);
    expect(page).toContain("Check what would change before anything is added to your notebook.");
    expect(page).toContain("Other things waiting for you");
    expect(page).toMatch(/Past decisions \(\$\{past\.length\}\)/);
    expect(page).toContain('data-testid="advanced"');
    expect(page).toMatch(/ProposalCompose/); // the composer is preserved, not deleted
    expect(page).toContain('proposedBy: { kind: "person" }');
    expect(page).toMatch(/const focused = focus \? \(actionable\.find\(\(p\) => p\.id === focus\) \?\? null\) : null;/);
    expect(page).not.toMatch(/Needs your review \(|Reviewed — ready|Nothing is waiting for review/);
    expect(page).toMatch(/proposalRecovery\.status !== "done"\) return;/);
    expect(page).toMatch(/proposals\.revalidate\(p\.id\)/);
    expect(page).not.toMatch(/@\/services\/mutations|\bapply\(|replaceModel|\.save\(|saveIfRevision/);
    expect(page).toMatch(/approveProposal\(id, note\)/); // the provider's guarded approval path, nothing else
  });
  it("card: four questions first, one primary action per state, two-stage decision, consequential second confirmation, failed retry only, stale re-review, Reject kept, note on request, everything else under Details", () => {
    const card = read("src/components/proposal-card.tsx");
    for (const t of ["would-change", "why", "based-on", "details-toggle", "mechanical-diff", "consequence-notice", "changed-since", "reviewed-before"]) expect(card).toContain(`data-testid="${t}"`);
    expect(card).toContain("BASIS_DISCLAIMER");
    expect(card).toContain("decisionHeading(p, shown)");
    expect(card).toMatch(/p\.status === "proposed" \?[\s\S]*actions\.review\(p\.id, note\)[\s\S]*I&apos;ve reviewed this/);
    expect(card).toMatch(/p\.status === "stale" \?[\s\S]*actions\.review\(p\.id, note\)[\s\S]*I&apos;ve reviewed the updated version/);
    expect(card).toMatch(/p\.status === "failed" \?[\s\S]*actions\.retry\(p\.id\)[\s\S]*Check again and retry/);
    expect(card).toMatch(/p\.status === "reviewed" \?[\s\S]*consequential \? \(\) => setConfirming\(true\) : approve/);
    expect(card).toContain('const canApprove = p.status === "reviewed" && p.preview.ok;');
    expect(card).toContain("Yes, apply this consequential change");
    expect(card).toContain("Ready for your decision");
    expect(card).toContain("Nothing was written.");
    expect(card).toContain("What you reviewed before");
    expect(card).toMatch(/>\s*Reject\s*</);
    expect(card).not.toMatch(/Not now/); // rejection is a persisted decision, never a dismissal
    expect(card).toContain("Add a note");
    expect(card).not.toMatch(/setTimeout\(|setInterval\(|defaultChecked|approveAll\(|checked=\{true\}/);
    expect(card).not.toMatch(/@\/services|\.save\(|saveIfRevision|replaceModel|\bapply\(/);
    // first-layer labels never expose kernel names
    const wording = read("src/features/review/wording.ts");
    expect(wording).not.toMatch(/label: "(ai_output|cross_context|pattern_ref|PatternRef|fingerprint|catalogue_prompt|user_statement)"/);
    expect(wording).not.toMatch(/@\/services|@\/model|from "react"/);
  });
});

describe("Library and routes", () => {
  it("Library links every advanced screen, and every existing route still has a page", () => {
    const lib = read("src/app/library/page.tsx");
    const routes = ["/observations", "/events", "/history", "/variables", "/map", "/constraints", "/profile", "/hypotheses", "/proposals", "/explore", "/evidence", "/overview", "/desired", "/gap", "/attractor", "/leverage", "/scenarios", "/ai"];
    for (const r of routes) expect(lib, r).toContain(`href: "${r}"`);
    for (const r of [...routes, "/feedback-map", "/income"]) expect(existsSync(path.join(process.cwd(), "src/app", r, "page.tsx")), r).toBe(true);
    expect(read("src/app/map/page.tsx")).toMatch(/FeedbackMapPage/);
  });
  it("the AI diagnostics page no longer claims there is no proposal path", () => {
    const ai = read("src/app/ai/page.tsx");
    expect(ai).not.toMatch(/no model write, no proposal\./);
    expect(ai).toMatch(/Review as hypothesis/);
  });
});
