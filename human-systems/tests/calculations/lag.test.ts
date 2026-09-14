import { describe, expect, it } from "vitest";
import {
  DAYS_PER_MONTH,
  formatLag,
  formatMonths,
  HORIZON_ORDER,
  horizonOfLag,
  horizonOfMonths,
  lagToDays,
  lagToMonths,
  monthsToLag,
  sumLagsMonths,
  type Horizon,
} from "@/calculations/lag";
import { LagSchema, RelationshipSchema, type Lag } from "@/types";

const lag = (value: number, unit: Lag["unit"]): Lag => ({ value, unit });

describe("lagToMonths / lagToDays", () => {
  it("DAYS_PER_MONTH is the mean Gregorian month", () => {
    expect(DAYS_PER_MONTH).toBe(365.25 / 12);
  });
  it("converts each unit", () => {
    expect(lagToMonths(lag(30.4375, "days"))).toBeCloseTo(1, 12);
    expect(lagToMonths(lag(1, "days"))).toBeCloseTo(1 / 30.4375, 12);
    expect(lagToMonths(lag(1, "weeks"))).toBeCloseTo(7 / 30.4375, 12);
    expect(lagToMonths(lag(3, "weeks"))).toBeCloseTo(21 / 30.4375, 12);
    expect(lagToMonths(lag(1, "months"))).toBe(1);
    expect(lagToMonths(lag(2.5, "months"))).toBe(2.5);
    expect(lagToMonths(lag(1, "years"))).toBe(12);
    expect(lagToMonths(lag(0.5, "years"))).toBe(6);
    expect(lagToMonths(lag(0, "years"))).toBe(0);
  });
  it("lagToDays inverts the month conversion", () => {
    expect(lagToDays(lag(1, "months"))).toBeCloseTo(30.4375, 12);
    expect(lagToDays(lag(2, "weeks"))).toBeCloseTo(14, 12);
    expect(lagToDays(lag(3, "days"))).toBeCloseTo(3, 12);
    expect(lagToDays(lag(1, "years"))).toBeCloseTo(365.25, 12);
  });
  it("sumLagsMonths adds mixed units in months", () => {
    const total = sumLagsMonths([lag(1, "years"), lag(6, "months"), lag(2, "weeks"), lag(30.4375, "days")]);
    expect(total).toBeCloseTo(12 + 6 + 14 / 30.4375 + 1, 12);
    expect(sumLagsMonths([])).toBe(0);
    expect(sumLagsMonths([lag(0, "days")])).toBe(0);
  });
});

describe("horizonOfMonths boundaries", () => {
  it("classifies each boundary as documented", () => {
    expect(horizonOfMonths(0)).toBe("immediate");
    expect(horizonOfMonths(-1)).toBe("immediate");
    expect(horizonOfMonths(6 / DAYS_PER_MONTH)).toBe("days");
    expect(horizonOfMonths(6.99 / DAYS_PER_MONTH)).toBe("days");
    expect(horizonOfMonths(7 / DAYS_PER_MONTH)).toBe("weeks");
    expect(horizonOfMonths(0.99)).toBe("weeks");
    expect(horizonOfMonths(1)).toBe("months");
    expect(horizonOfMonths(11.9)).toBe("months");
    expect(horizonOfMonths(12)).toBe("years");
    expect(horizonOfMonths(240)).toBe("years");
  });
  it("horizonOfLag goes through lagToMonths", () => {
    expect(horizonOfLag(lag(0, "months"))).toBe("immediate");
    expect(horizonOfLag(lag(6, "days"))).toBe("days");
    expect(horizonOfLag(lag(1, "weeks"))).toBe("weeks");
    expect(horizonOfLag(lag(4, "weeks"))).toBe("weeks"); // 28 days < 1 month
    expect(horizonOfLag(lag(5, "weeks"))).toBe("months"); // 35 days > 1 month
    expect(horizonOfLag(lag(11, "months"))).toBe("months");
    expect(horizonOfLag(lag(12, "months"))).toBe("years");
    expect(horizonOfLag(lag(1, "years"))).toBe("years");
    expect(horizonOfLag(lag(365.25, "days"))).toBe("years");
  });
  it("HORIZON_ORDER runs from immediate to years", () => {
    expect(HORIZON_ORDER).toEqual(["immediate", "days", "weeks", "months", "years"]);
    // Monotone: larger month counts never move earlier in the order.
    const samples = [0, 1 / DAYS_PER_MONTH, 7 / DAYS_PER_MONTH, 0.5, 1, 6, 12, 100];
    const ranks = samples.map((m) => HORIZON_ORDER.indexOf(horizonOfMonths(m)));
    for (let i = 1; i < ranks.length; i += 1) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
  });
});

describe("monthsToLag picks a natural unit", () => {
  it("chooses days under 14 days, weeks under 1 month, months under 2 years, else years", () => {
    expect(monthsToLag(0)).toEqual({ value: 0, unit: "days" });
    expect(monthsToLag(-3)).toEqual({ value: 0, unit: "days" });
    expect(monthsToLag(1 / DAYS_PER_MONTH)).toEqual({ value: 1, unit: "days" });
    expect(monthsToLag(13 / DAYS_PER_MONTH)).toEqual({ value: 13, unit: "days" });
    expect(monthsToLag(0.5)).toEqual({ value: 2.2, unit: "weeks" }); // 15.21875 days / 7 = 2.17...
    expect(monthsToLag(0.99)).toEqual({ value: 4.3, unit: "weeks" }); // 30.13 days / 7 = 4.30...
    expect(monthsToLag(1.99)).toEqual({ value: 2, unit: "months" }); // one month or more stays in months
    expect(monthsToLag(2)).toEqual({ value: 2, unit: "months" });
    expect(monthsToLag(6)).toEqual({ value: 6, unit: "months" });
    expect(monthsToLag(18)).toEqual({ value: 18, unit: "months" });
    expect(monthsToLag(23.96)).toEqual({ value: 24, unit: "months" }); // rounded to one decimal, still < 24 months branch
    expect(monthsToLag(24)).toEqual({ value: 2, unit: "years" });
    expect(monthsToLag(30)).toEqual({ value: 2.5, unit: "years" });
    expect(monthsToLag(100)).toEqual({ value: 8.3, unit: "years" });
  });
});

describe("formatLag / formatMonths strings", () => {
  it("formats zero as immediate and singularises a value of 1", () => {
    expect(formatLag(lag(0, "months"))).toBe("immediate");
    expect(formatLag(lag(0, "days"))).toBe("immediate");
    expect(formatMonths(0)).toBe("immediate");
    expect(formatLag(lag(1, "days"))).toBe("1 day");
    expect(formatLag(lag(1, "weeks"))).toBe("1 week");
    expect(formatLag(lag(1, "months"))).toBe("1 month");
    expect(formatLag(lag(1, "years"))).toBe("1 year");
  });
  it("prints integers plainly and non-integers to one decimal", () => {
    expect(formatLag(lag(3, "days"))).toBe("3 days");
    expect(formatLag(lag(2, "weeks"))).toBe("2 weeks");
    expect(formatLag(lag(6, "months"))).toBe("6 months");
    expect(formatLag(lag(1.5, "years"))).toBe("1.5 years");
    expect(formatLag(lag(1.25, "weeks"))).toBe("1.3 weeks");
    expect(formatLag(lag(0.5, "months"))).toBe("0.5 months");
    expect(formatLag(lag(2.04, "years"))).toBe("2.0 years"); // toFixed(1), not re-rounded
  });
  it("formatMonths goes through monthsToLag", () => {
    expect(formatMonths(1 / DAYS_PER_MONTH)).toBe("1 day");
    expect(formatMonths(3 / DAYS_PER_MONTH)).toBe("3 days");
    expect(formatMonths(14 / DAYS_PER_MONTH)).toBe("2 weeks");
    expect(formatMonths(0.46)).toBe("2 weeks"); // 14.00125 days -> 2.0 weeks
    expect(formatMonths(0.5)).toBe("2.2 weeks");
    expect(formatMonths(6)).toBe("6 months");
    expect(formatMonths(1)).toBe("1 month"); // one month or more is printed in months
    expect(formatMonths(2)).toBe("2 months");
    expect(formatMonths(18)).toBe("18 months"); // under 24 months stays in months
    expect(formatMonths(24)).toBe("2 years");
    expect(formatMonths(30)).toBe("2.5 years");
    expect(formatMonths(12)).toBe("12 months");
  });
});

describe("round trips", () => {
  it("lag -> months -> monthsToLag preserves the horizon class away from the boundaries", () => {
    const cases: Array<[Lag, Horizon]> = [
      [lag(0, "weeks"), "immediate"],
      [lag(3, "days"), "days"],
      [lag(10, "days"), "weeks"],
      [lag(3, "weeks"), "weeks"],
      [lag(1.5, "months"), "months"],
      [lag(5, "months"), "months"],
      [lag(45, "weeks"), "months"],
      [lag(2, "years"), "years"],
      [lag(400, "days"), "years"],
    ];
    for (const [original, expected] of cases) {
      const months = lagToMonths(original);
      const natural = monthsToLag(months);
      expect(horizonOfLag(original), formatLag(original)).toBe(expected);
      expect(horizonOfLag(natural), formatLag(original)).toBe(expected);
      expect(horizonOfMonths(months), formatLag(original)).toBe(expected);
    }
  });
  it("exactly one month keeps the months horizon through monthsToLag", () => {
    // Natural-unit rounding must never cross a horizon boundary at 1 month:
    // monthsToLag switches from weeks to months exactly where the class does.
    const original = lag(1, "months");
    expect(horizonOfLag(original)).toBe("months");
    const natural = monthsToLag(lagToMonths(original));
    expect(natural).toEqual({ value: 1, unit: "months" });
    expect(horizonOfLag(natural)).toBe("months");
    const justUnder = monthsToLag(0.99);
    expect(justUnder.unit).toBe("weeks");
    expect(horizonOfLag(justUnder)).toBe("weeks");
  });
  it("RelationshipSchema JSON round trip keeps the unit exactly", () => {
    const parsed = RelationshipSchema.parse({
      id: "r",
      sourceVariableId: "a",
      targetVariableId: "b",
      kind: "causal_hypothesis",
      participatesInDynamics: true,
      direction: "positive",
      strength: 0.5,
      lag: { value: 3, unit: "weeks" },
      confidence: 0.5,
      sourceType: "self_reported",
    });
    const roundTripped = RelationshipSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped.lag).toEqual({ value: 3, unit: "weeks" });
    expect(roundTripped.lag.unit).toBe("weeks");
    expect(roundTripped).toEqual(parsed);
    for (const unit of ["days", "weeks", "months", "years"] as const) {
      const l = LagSchema.parse(JSON.parse(JSON.stringify({ value: 2.5, unit })));
      expect(l).toEqual({ value: 2.5, unit });
    }
  });
});
