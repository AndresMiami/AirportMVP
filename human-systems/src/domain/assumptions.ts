/**
 * Registry of MODEL ASSUMPTIONS.
 *
 * Every formula in calculations/ cites one or more of these ids. The
 * Evidence / Assumptions screen renders this list so a reader can see
 * exactly which conventions the numbers rest on. None of these are
 * established scientific laws; they are working conventions chosen for
 * the MVP and open to revision.
 */
export type AssumptionStatus = "convention" | "hypothesis" | "placeholder";

export interface ModelAssumption {
  id: string;
  title: string;
  statement: string;
  status: AssumptionStatus;
  /** Where the assumption is used. */
  usedBy: string[];
}

export const ASSUMPTIONS: ModelAssumption[] = [
  {
    id: "A1",
    title: "Reliable income floor",
    statement:
      "Floor = sum over sources of (monthly amount x reliability), where reliability is the fraction of the amount that can be counted on in a bad month. This is a judgment per source, not a measured distribution.",
    status: "convention",
    usedBy: ["reliableIncomeFloor", "floorRatio"],
  },
  {
    id: "A2",
    title: "Buffer months use essential expenses only",
    statement:
      "Buffer months = liquid reserves / essential monthly expenses. Discretionary spending is assumed to be cut first in a crisis.",
    status: "convention",
    usedBy: ["bufferMonths"],
  },
  {
    id: "A3",
    title: "Income concentration via HHI",
    statement:
      "H = sum of squared income shares. 1 = a single source, 1/n = n equal sources. Shares use gross monthly amounts.",
    status: "convention",
    usedBy: ["incomeConcentration"],
  },
  {
    id: "A4",
    title: "Failure correlation as largest correlated block",
    statement:
      "Sources sharing a correlation group are assumed to fail together. Failure correlation = the largest share of income held by one group.",
    status: "convention",
    usedBy: ["failureCorrelation"],
  },
  {
    id: "A5",
    title: "Share-weighted volatility and replacement latency",
    statement:
      "Household income volatility and replacement latency are income-share-weighted means of the per-source values.",
    status: "convention",
    usedBy: ["incomeVolatility", "replacementLatency"],
  },
  {
    id: "A6",
    title: "Career-capital step model",
    statement:
      "C(t+1) = C(t) + effortToCapitalRate x qualityOfEffort x protectedHours x persistence - switchingCost. Career capital is an index whose scale is set by the estimated effortToCapitalRate; only its direction and relative change are meaningful.",
    status: "hypothesis",
    usedBy: ["careerCapitalStep", "projectCareerCapital"],
  },
  {
    id: "A7",
    title: "Productive-capital step model",
    statement:
      "A(t+1) = A(t) + capitalConversionRate x max(0, income - expenses) + A(t) x monthlyReturnRate. Expenses include essential, discretionary and debt payments.",
    status: "hypothesis",
    usedBy: ["productiveCapitalStep", "projectProductiveCapital"],
  },
  {
    id: "A8",
    title: "Leverage score",
    statement:
      "L = (impact x controllability x durability) / (max(cost, 0.05) x max(uncertainty, 0.05)). All five factors are 0..1 ordinal judgments. Only the RANK of scores is meaningful; the magnitude is not. Relationship strengths are likewise judgments, not estimated causal coefficients.",
    status: "hypothesis",
    usedBy: ["leverageScore"],
  },
  {
    id: "A9",
    title: "Loop polarity and gain",
    statement:
      "A loop is reinforcing when it contains an even number of negative edges, balancing otherwise. Loop gain = product of edge strengths (0..1 judgments), not a measured elasticity.",
    status: "convention",
    usedBy: ["loopPolarity", "loopGain"],
  },
  {
    id: "A10",
    title: "Loop pressure index",
    statement:
      "Loop pressure = (geometric mean of the loop's edge strengths) x (mean normalised gap of the loop's variables that have a desired value). High pressure on a reinforcing loop means its variables currently sit far from the desired state while feeding each other. The geometric mean is used instead of the raw product so long loops are not penalised for having more edges. It is a diagnostic index, not a rate.",
    status: "hypothesis",
    usedBy: ["loopPressure", "compareScenario"],
  },
  {
    id: "A11",
    title: "Gap normalisation",
    statement:
      "Normalised gap = |desired - current| / (referenceRange.max - referenceRange.min) when a reference range exists, otherwise |desired - current| / max(|desired|, |current|). Clipped to 0..1. A desired value is read per its targetMode: a floor (at_least) already met or a ceiling (at_most) already respected counts as a closed gap.",
    status: "convention",
    usedBy: ["structuralGap"],
  },
  {
    id: "A12",
    title: "Directional propagation",
    statement:
      "A change pushes each downstream variable in the edge's direction with weight equal to the product of strengths along the path, up to a fixed depth. Only the SIGN of the resulting tendency is reported; magnitudes are not predictions.",
    status: "hypothesis",
    usedBy: ["propagateDirectionalPressure"],
  },
  {
    id: "A13",
    title: "Derived confidence",
    statement:
      "A calculated variable's confidence is the minimum confidence among its inputs.",
    status: "convention",
    usedBy: ["computeDerivedVariables"],
  },
  {
    id: "A14",
    title: "Feasibility is a hard filter",
    statement:
      "An action is infeasible if any HARD constraint whose dimension the action declares is violated. Constraints on dimensions the action does not declare are reported as unverified, not as violations; constraints with no machine-checkable rule are reported as unchecked.",
    status: "convention",
    usedBy: ["checkFeasibility"],
  },
  {
    id: "A16",
    title: "Lag units and horizon classes",
    statement:
      "Lags are stored in the unit entered (days, weeks, months, years) and converted with 30.4375 days per month only for arithmetic. Horizon classes for display: immediate (0), days (< 1 week), weeks (< 1 month), months (< 1 year), years. Cycle time is the plain sum of edge lags; propagation reports the shortest and longest cumulative lag along the paths found.",
    status: "convention",
    usedBy: ["lagToMonths", "horizonOfMonths", "findFeedbackLoops", "propagateDirectionalPressure"],
  },
  {
    id: "A17",
    title: "Soft-constraint suitability",
    statement:
      "A violated SOFT constraint never excludes an action; suitability = product over violated soft constraints of (1 - softPenalty), shown next to the leverage rank and never folded into it.",
    status: "convention",
    usedBy: ["checkFeasibility"],
  },
  {
    id: "A18",
    title: "Loops are hypotheses",
    statement:
      "A detected loop is a structural consequence of the entered edges, and each edge is a model judgment. A loop's epistemic status is the status of its hypothesis (proposed, accepted, rejected, uncertain); 'accepted' means the person accepts it as a working reading, never that it is established.",
    status: "convention",
    usedBy: ["evaluateSystem"],
  },
  {
    id: "A15",
    title: "Monthly hours conversion",
    statement: "Weekly hours are converted to monthly hours with a factor of 4.33.",
    status: "convention",
    usedBy: ["projectCareerCapital"],
  },
  {
    id: "A19",
    title: "Signature dimension normalisation",
    statement:
      "A structural dimension is a weighted mean (or min/max) of its contributing variables after each is mapped to 0..1 by a declared transform (linear range or ratio to a 'strong' value), inverted where a higher raw value is the weaker position, and clipped. Ranges, thresholds and weights live in the signature definition and are conventions, not findings. The continuous value is canonical; 'weak/strong' and bands are display classifications derived from it.",
    status: "convention",
    usedBy: ["computeDimension", "HOUSEHOLD_SIGNATURE_V1"],
  },
  {
    id: "A20",
    title: "Unknown is not zero",
    statement:
      "A contributing variable that is absent or has no value is UNKNOWN. It is excluded from the aggregate rather than counted as 0; a dimension becomes unknown (value null, confidence 0, strip character '?') when a required input is unknown or fewer than the minimum number of inputs are known.",
    status: "convention",
    usedBy: ["computeDimension", "compactStrip"],
  },
  {
    id: "A21",
    title: "Dimension confidence",
    statement:
      "Dimension confidence = (weighted mean, or minimum, of the known inputs' confidence) × (share of input weight that was known). Overall signature confidence is the mean over known dimensions; completeness is the share of dimensions that are known.",
    status: "convention",
    usedBy: ["computeDimension", "computeSignature"],
  },
  {
    id: "A22",
    title: "Question priority heuristic",
    statement:
      "priority = importance × uncertainty × influence, where importance is the definition's weight, uncertainty is 1 for an unknown dimension and (1 - confidence) otherwise, and influence = max(0.1, 0.5 × mean network influence of the dimension's variables + 0.5 × share of detected loops touching them). Multiplicative with a floor, so there is no division. A MODEL HEURISTIC, not an information-theoretic quantity.",
    status: "hypothesis",
    usedBy: ["questionPriorities"],
  },
  {
    id: "A23",
    title: "Change and persistence thresholds",
    statement:
      "Between two snapshots a dimension or variable 'changed' when its normalised value moved by at least 0.10 and is 'persistent' when both values are known and moved less. Across several snapshots an item is persistent when its range over the known snapshots is below 0.10. Confidence 'improved' at +0.10. Repeated appearance of a pattern is reported as repetition, never as cause.",
    status: "convention",
    usedBy: ["compareSignatures", "persistenceIndicators", "recurringRelationships"],
  },
  {
    id: "A24",
    title: "Gap bands",
    statement:
      "Per-dimension gap = desired - current on the 0..1 scale. Bands: none < 0.05, small < 0.15, moderate < 0.30, large < 0.50, very large otherwise; 'already strong' when there is no gap and the current value is at or above the strong threshold. Gaps are reported as a vector; there is no total.",
    status: "convention",
    usedBy: ["signatureGap"],
  },
];

export const ASSUMPTION_BY_ID: Record<string, ModelAssumption> = Object.fromEntries(
  ASSUMPTIONS.map((a) => [a.id, a]),
);
