/**
 * Stored-state migrations. Each step upgrades a raw JSON object from
 * version N to N+1 without importing the strict schemas of older versions
 * (they no longer exist in code). The final object is validated with the
 * current SystemModelSchema; anything that fails is reported, never
 * half-loaded.
 */
import { MODEL_SCHEMA_VERSION, SystemModelSchema, type SystemModel } from "@/types";

type Raw = Record<string, unknown>;

export interface MigrationOutcome {
  model: SystemModel;
  /** Version the stored object had before migration; null if current. */
  migratedFrom: number | null;
}

export type MigrationResult = { ok: true } & MigrationOutcome | { ok: false; error: string };

function isRecord(x: unknown): x is Raw {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asArray(x: unknown): Raw[] {
  return Array.isArray(x) ? x.filter(isRecord) : [];
}

/** v1 -> v2: relationship field names + lag object + provenance fields,
 *  hard/soft constraints with an explicit check, member ids, and the new
 *  observations / hypotheses collections. */
export function migrateV1toV2(v1: Raw): Raw {
  const relationships = asArray(v1.relationships).map((r) => {
    const lagMonths = typeof r.lagMonths === "number" ? r.lagMonths : 0;
    const { sourceVariable, targetVariable, lagMonths: _drop, ...rest } = r;
    void _drop;
    return {
      ...rest,
      sourceVariableId: r.sourceVariableId ?? sourceVariable,
      targetVariableId: r.targetVariableId ?? targetVariable,
      lag: r.lag ?? { value: lagMonths, unit: "months" },
      evidence: r.evidence ?? [],
      notes: r.notes ?? "",
      enabled: r.enabled ?? true,
    };
  });
  const constraints = asArray(v1.constraints).map((c) => {
    const { dimension, comparator, limit, ...rest } = c;
    const check =
      c.check ??
      (typeof dimension === "string" && typeof comparator === "string" && limit !== undefined
        ? { dimension, comparator, limit }
        : undefined);
    return {
      ...rest,
      type: c.type ?? "hard",
      ...(check ? { check } : {}),
      evidence: c.evidence ?? [],
      userConfirmed: c.userConfirmed ?? false,
    };
  });
  const profile = isRecord(v1.profile) ? v1.profile : {};
  const members = asArray(profile.members).map((m, i) => ({
    ...m,
    id: typeof m.id === "string" && m.id ? m.id : `member_${i + 1}`,
    label: typeof m.label === "string" && m.label ? m.label : `Member ${i + 1}`,
  }));
  return {
    ...v1,
    schemaVersion: 2,
    profile: { ...profile, members },
    relationships,
    constraints,
    observations: v1.observations ?? [],
    hypotheses: v1.hypotheses ?? [],
  };
}

const STEPS: Record<number, (raw: Raw) => Raw> = {
  1: migrateV1toV2,
};

export function migrateModel(input: unknown): MigrationResult {
  if (!isRecord(input)) return { ok: false, error: "Stored model is not an object" };
  let raw: Raw = input;
  const from = typeof raw.schemaVersion === "number" ? raw.schemaVersion : null;
  if (from === null) return { ok: false, error: "Stored model has no schemaVersion" };
  if (from > MODEL_SCHEMA_VERSION) {
    return { ok: false, error: `Stored model is version ${from}; this build understands up to ${MODEL_SCHEMA_VERSION}` };
  }
  let version = from;
  while (version < MODEL_SCHEMA_VERSION) {
    const step = STEPS[version];
    if (!step) return { ok: false, error: `No migration from version ${version}` };
    raw = step(raw);
    version += 1;
  }
  const parsed = SystemModelSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Migrated model failed validation: ${parsed.error.message}` };
  return { ok: true, model: parsed.data, migratedFrom: from === MODEL_SCHEMA_VERSION ? null : from };
}
