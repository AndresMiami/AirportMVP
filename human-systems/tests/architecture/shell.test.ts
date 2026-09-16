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
    expect(home).toMatch(/recurrenceCards\(model/);
    expect(home).toMatch(/openProposalCount\(ledger\)/);
    expect(home).toMatch(/workingHypotheses\(model\)/);
    expect(home).toMatch(/Reflection demo/);
    expect(home).not.toMatch(/structural gap|attractor|model health|cross-context|recurrence set/i);
    const cards = read("src/features/home/cards.ts");
    expect(cards).toMatch(/describeVariableHistory\(/);
    expect(cards).not.toMatch(/from "react"|@\/domains|@\/services/);
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
