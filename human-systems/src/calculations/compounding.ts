/**
 * Step models for the two compounding quantities (assumptions A6, A7, A15).
 * These are MODEL ASSUMPTIONS, not established laws. They exist so that a
 * scenario can show the direction and rough shape of compounding, never to
 * predict a number.
 */

export const WEEKS_PER_MONTH = 4.33;

export interface CareerCapitalParams {
  qualityOfEffort: number; // 0..1
  protectedHoursPerMonth: number; // >= 0
  persistence: number; // 0..1
  /** Index points gained per effective hour (q x h x p). Sets the scale of
   *  the index; an estimate, never measured. */
  effortToCapitalRate: number; // >= 0
  /** Career-capital points lost per month to switching (cost x frequency). */
  switchingCostPerMonth: number; // >= 0
}

/** A6: C(t+1) = C + rate * q * h * p - switchingCost. Never below zero. */
export function careerCapitalStep(current: number, p: CareerCapitalParams): number {
  const growth = p.effortToCapitalRate * p.qualityOfEffort * p.protectedHoursPerMonth * p.persistence;
  return Math.max(0, current + growth - p.switchingCostPerMonth);
}

export interface ProductiveCapitalParams {
  capitalConversionRate: number; // 0..1
  monthlyIncome: number;
  monthlyExpenses: number; // essential + discretionary + debt payments
  /** Monthly return on existing capital (e.g. 0.004 for ~5%/yr). */
  monthlyReturnRate: number;
}

/** A7: A(t+1) = A + rate * max(0, income - expenses) + A * return. */
export function productiveCapitalStep(current: number, p: ProductiveCapitalParams): number {
  const surplus = Math.max(0, p.monthlyIncome - p.monthlyExpenses);
  return current + p.capitalConversionRate * surplus + current * p.monthlyReturnRate;
}

/** Iterate a step function `months` times; index 0 is the starting value. */
export function projectSeries(
  start: number,
  months: number,
  step: (value: number, monthIndex: number) => number,
): number[] {
  const series = [start];
  let v = start;
  for (let m = 0; m < months; m += 1) {
    v = step(v, m);
    series.push(v);
  }
  return series;
}

export function projectCareerCapital(
  start: number,
  months: number,
  p: CareerCapitalParams,
): number[] {
  return projectSeries(start, months, (v) => careerCapitalStep(v, p));
}

export function projectProductiveCapital(
  start: number,
  months: number,
  p: ProductiveCapitalParams,
): number[] {
  return projectSeries(start, months, (v) => productiveCapitalStep(v, p));
}

/** A15: weekly -> monthly hours. */
export function weeklyToMonthlyHours(hoursPerWeek: number): number {
  return hoursPerWeek * WEEKS_PER_MONTH;
}

/** Annual rate -> equivalent monthly compounding rate. */
export function annualToMonthlyRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}
