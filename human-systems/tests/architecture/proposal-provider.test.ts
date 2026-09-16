/**
 * Source pins for the provider's proposal integration: approval goes
 * through ProposalService.approve, the persisted model is ADOPTED into
 * React state, and nothing is saved again through the optimistic path.
 * Executed behavior lives in the kernel tests and the Chromium check;
 * these pins keep the wiring from drifting.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.join(process.cwd(), "src/components/model-provider.tsx"), "utf8");

describe("provider: proposal approval adopts the persisted model", () => {
  it("approveProposal calls the kernel and adopts result.model with setModel, never persist()/save()", () => {
    const start = src.indexOf("const approveProposal = useCallback");
    const end = src.indexOf("const setAsOf = useCallback", start);
    expect(start).toBeGreaterThan(0);
    const body = src
      .slice(start, end)
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(body).toMatch(/kernel\.approve\(id, note\)/);
    expect(body).toMatch(/if \(result\.ok\) \{[\s\S]*setModel\(result\.model\)/);
    expect(body).not.toMatch(/persist\(/);
    expect(body).not.toMatch(/\.save\(/);
    expect(body).not.toMatch(/apply\(/);
  });

  it("startup recovery runs before the kernel is exposed and again when the active model changes", () => {
    expect(src).toMatch(/await recoverProposals\(model\.id\);\s*setProposals\(kernel\);\s*setStatus\("ready"\);/);
    expect(src).toMatch(/await refreshList\(\);\s*await recoverProposals\(next\.id\);/);
  });

  it("the proposals page acts only after recovery is done and revalidates through the kernel", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/proposals/page.tsx"), "utf8");
    expect(page).toMatch(/proposalRecovery\.status !== "done"\) return;/);
    expect(page).toMatch(/proposals\.revalidate\(p\.id\)/);
    expect(page).not.toMatch(/\bapply\(/);
    expect(page).not.toMatch(/replaceModel/);
  });
});
