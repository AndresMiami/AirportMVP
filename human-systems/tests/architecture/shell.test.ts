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
