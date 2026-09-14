/**
 * VariableRef carries an EXPLICIT scope. Storage keeps `subjectId === null`
 * as UNASSIGNED; the engine never overloads null to mean "the system".
 */
import { describe, expect, it } from "vitest";
import { refFor, resolveVariable, subjectRef, systemRef, unassignedVariables } from "@/model/domain";
import type { Variable } from "@/types";

const SYSTEM = "sys_1";

function variable(id: string, key: string, subjectId: string | null, currentValue: number | null): Variable {
  return {
    id,
    key,
    subjectId,
    name: id,
    description: "",
    category: "event",
    changeSpeed: "fast",
    kind: "input",
    currentValue,
    desiredValue: null,
    targetMode: "exact",
    unit: "h",
    sourceType: "self_reported",
    confidence: 0.5,
    evidence: [],
    controllability: 0.5,
    durability: 0.5,
    estimatedCostToChange: 0.5,
    notes: "",
  };
}

// The same key exists once per subject, plus one unassigned copy.
const VARIABLES: Variable[] = [
  variable("hours", "hours", SYSTEM, 100),
  variable("hours@ana", "hours", "ana", 30),
  variable("hours@bo", "hours", "bo", 20),
  variable("hours_unassigned", "hours", null, 999),
  variable("only_ana", "only_ana", "ana", 1),
  variable("only_unassigned", "only_unassigned", null, 2),
];

describe("resolveVariable with explicit scope", () => {
  it("a system reference resolves only the system-attributed variable", () => {
    const v = resolveVariable(VARIABLES, SYSTEM, systemRef("hours"));
    expect(v?.id).toBe("hours");
    expect(v?.subjectId).toBe(SYSTEM);
    expect(resolveVariable(VARIABLES, SYSTEM, systemRef("only_ana"))).toBeUndefined();
  });

  it("a subject reference resolves only that subject's variable", () => {
    expect(resolveVariable(VARIABLES, SYSTEM, subjectRef("hours", "ana"))?.id).toBe("hours@ana");
    expect(resolveVariable(VARIABLES, SYSTEM, subjectRef("hours", "bo"))?.id).toBe("hours@bo");
    expect(resolveVariable(VARIABLES, SYSTEM, subjectRef("hours", "cy"))).toBeUndefined();
    expect(resolveVariable(VARIABLES, SYSTEM, subjectRef("only_ana", "bo"))).toBeUndefined();
  });

  it("an unassigned variable never resolves as the system or as anyone", () => {
    expect(resolveVariable(VARIABLES, SYSTEM, systemRef("only_unassigned"))).toBeUndefined();
    expect(resolveVariable(VARIABLES, SYSTEM, subjectRef("only_unassigned", "ana"))).toBeUndefined();
    // and it is not shadowed into the system slot either: the system copy wins because it IS the system's
    expect(resolveVariable(VARIABLES, SYSTEM, systemRef("hours"))?.currentValue).toBe(100);
    expect(unassignedVariables(VARIABLES).map((v) => v.id)).toEqual(["hours_unassigned", "only_unassigned"]);
  });

  it("the same key lives once per subject without collision", () => {
    const hours = VARIABLES.filter((v) => v.key === "hours");
    expect(hours).toHaveLength(4);
    const resolved = [systemRef("hours"), subjectRef("hours", "ana"), subjectRef("hours", "bo")].map((ref) => resolveVariable(VARIABLES, SYSTEM, ref)!);
    expect(new Set(resolved.map((v) => v.id)).size).toBe(3);
    expect(resolved.map((v) => v.currentValue)).toEqual([100, 30, 20]);
  });

  it("refFor turns a KNOWN subject id into the right reference and never takes null", () => {
    expect(refFor("hours", SYSTEM, SYSTEM)).toEqual({ key: "hours", scope: "system" });
    expect(refFor("hours", "ana", SYSTEM)).toEqual({ key: "hours", scope: "subject", subjectId: "ana" });
    // the type forbids null; the runtime shape has no null-bearing member at all
    expect(Object.values(systemRef("hours"))).not.toContain(null);
    // The type forbids null; if untyped data smuggles one in, the runtime guard
    // still refuses to match the UNASSIGNED rows.
    // @ts-expect-error null is not a subject
    const smuggled = refFor("hours", null, SYSTEM);
    expect(resolveVariable(VARIABLES, SYSTEM, smuggled)).toBeUndefined();
    // @ts-expect-error a VariableRef with subjectId null is not a valid shape
    const bad: Parameters<typeof resolveVariable>[2] = { key: "hours", scope: "subject", subjectId: null };
    expect(resolveVariable(VARIABLES, SYSTEM, bad)).toBeUndefined();
    expect(resolveVariable(VARIABLES, SYSTEM, { key: "hours", scope: "subject", subjectId: "" })).toBeUndefined();
  });
});
