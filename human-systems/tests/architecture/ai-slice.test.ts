/**
 * STEP 7A — source pins for the first real AI slice: the key lives only on
 * the server, the server bundle is alias-free, calls are tap-initiated,
 * the boundary is shown, failures are one line, nothing new can write.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const srcFiles = () => walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));

describe("credentials never reach the browser", () => {
  it("no file under src imports the provider SDK, names the key or reads any environment value but the one public flag", () => {
    for (const f of srcFiles()) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/@anthropic-ai\/sdk|ANTHROPIC|sk-ant-/);
      const envReads = s.match(/process\.env\.[A-Z_]+/g) ?? [];
      if (f.endsWith("src/ai/task-select.ts")) expect(envReads).toEqual(["process.env.NEXT_PUBLIC_AI_PROVIDER"]);
      else expect(envReads, f).toEqual([]);
    }
    expect(read("src/ai/task-select.ts")).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN)/);
  });
  it("the function reads the key from the server environment only and logs one structured line without content", () => {
    const fn = read("netlify/functions/ai-task.ts");
    expect(fn).toMatch(/env\.ANTHROPIC_API_KEY/);
    expect(fn).toMatch(/maxRetries: 0/);
    expect(fn).not.toMatch(/console\.(log|error|warn|info)\([^)]*(raw|text|body|payload|items|userMessage|outcome\.)/);
    expect(fn.match(/console\.log\(/g)).toHaveLength(1);
    expect(fn).toMatch(/JSON\.stringify\(\{ event: "ai-task", task, outcome/);
    expect(fn).toMatch(/export const config = \{ path: "\/api\/ai-task" \}/);
  });
  it("the server bundle and its imports use no '@/' alias; the SDK is a dependency the browser never imports", () => {
    for (const p of ["netlify/functions/ai-task.ts", "src/ai/remote-contract.ts", "src/ai/hash.ts"]) expect(read(p), p).not.toMatch(/from "@\//);
    expect(read("src/ai/remote-contract.ts")).toMatch(/import type \{[^}]*\} from "\.\/context"/);
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@anthropic-ai/sdk"]).toBeDefined();
    const toml = read("netlify.toml");
    expect(toml).toMatch(/\[functions\]\s*\n\s*directory = "netlify\/functions"/);
    expect(toml).toMatch(/ANTHROPIC_API_KEY/);
    expect(toml).not.toMatch(/sk-ant-/);
  });
  it.skipIf(!existsSync(path.join(root, "out")))("the exported bundle carries no key, no key name and no server module", () => {
    for (const f of walk(path.join(root, "out")).filter((f) => /\.(js|html|txt|json)$/.test(f))) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/sk-ant-|ANTHROPIC_API_KEY|HSL_AI_/);
    }
  });
});

describe("the surfaces", () => {
  it("Home: the configured provider runs only inside the tap handler, behind the one-time boundary, with one failure line and no epistemic vocabulary", () => {
    const home = read("src/app/page.tsx");
    expect(home).toMatch(/createTaskProvider\(KIND\)\.run\(providerPayload\(ctx\), ctx\.contextHash\)/);
    expect(home).not.toMatch(/MockAiTaskProvider|RemoteAiTaskProvider|fetch\(/);
    expect(home).toMatch(/needsDisclosure\(KIND, acknowledged\)/);
    expect(home).toMatch(/<AiFailure line=\{REFLECTION_FAILED\} detail=\{shown\.error\} \/>/);
    expect(home).toMatch(/data-testid="reflect"/);
    expect(home).toMatch(/onClick=\{\(\) => void reflect\(\)\}/);
    // no effect runs the provider: every useEffect body is free of .run(
    for (const body of home.split("useEffect(").slice(1)) expect(body.split("}, [")[0]).not.toMatch(/\.run\(|reflect\(/);
    expect(home).not.toMatch(/directly_stated|interpretive|tentative|unresolved|contextHash\}|token/);
    expect(home).toMatch(/Demo response · nothing is saved to your notebook\./);
    expect(home).toMatch(/source=home-draft/);
  });
  it("Explore: Help me think is a tap, candidates go through the unchanged 5D bridge to a person-submitted proposal, and nothing else can write", () => {
    const explore = read("src/app/explore/page.tsx");
    expect(explore).toMatch(/<button[^\n]*data-testid="help-me-think"/);
    expect(explore).toMatch(/createTaskProvider\(KIND\)\.run\(providerPayload\(ctx\), ctx\.contextHash\)/);
    expect(explore).toMatch(/toProposalSet\(current\.ctx, shown\.response, ADAPTER_IDS\[KIND\]\)/);
    expect(explore.match(/proposedBy: \{ kind: "person" \}/g)).toHaveLength(2);
    expect(explore).not.toMatch(/@\/services\/mutations|\bapply\(|models\.save|addHypothesis\(/);
    expect(explore).toMatch(/needsDisclosure\(KIND, acknowledged\)/);
    expect(explore).toMatch(/<AiFailure line=\{THINKING_FAILED\}/);
    for (const body of explore.split("useEffect(").slice(1)) expect(body.split("}, [")[0]).not.toMatch(/\.run\(|help\(/);
    expect(explore).toMatch(/stateWords\(it\.state\)/);
    expect(explore).toMatch(/citedLabels\(\[it\.forPattern, \.\.\.it\.restsOn\], items\)/);
  });
  it("the bridge, the whitelist and the response contract are untouched by this slice", () => {
    const bridge = read("src/ai/proposal-bridge.ts");
    expect(bridge).toMatch(/exactly one registered addHypothesis/);
    expect(bridge).not.toMatch(/addObservation|addEvent|addVariable|addRelationship|addConstraint|setValue|setTarget/);
    const response = read("src/ai/response.ts");
    expect(response).toMatch(/suggest_explanations_for_pattern: \["candidate_explanation", "question"\]/);
    expect(response).toMatch(/interpret_free_text: \["interpretation", "question"\]/);
    const remote = read("src/ai/task-remote.ts");
    expect(remote).toMatch(/validateAiResponse\(wire\.data\.response, payload, contextHash\)/);
    expect(remote).toMatch(/implements AiTaskProvider/);
    expect(remote.match(/this\.transport\(/g)).toHaveLength(1); // one attempt, no loop
    expect(remote).not.toMatch(/for \(|while \(/);
  });
  it("the boundary components and wording carry the disclosure sentence and a Details-only category", () => {
    const b = read("src/components/ai-boundary.tsx");
    expect(b).toMatch(/Review what is shared →/);
    expect(b).toMatch(/<details/);
    expect(b).toMatch(/data-testid="ai-disclosure-confirm"/);
    const w = read("src/features/ai/wording.ts");
    expect(w).toMatch(/AI reflection sends this note and the relevant notebook context to the AI provider\./);
    expect(w).toMatch(/Reflection couldn't be completed\. Try again\./);
  });
});
