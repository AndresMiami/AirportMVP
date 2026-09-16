/**
 * Stored-state migrations. Each step upgrades a raw JSON object from
 * version N to N+1 without importing the strict schemas of older versions
 * (they no longer exist in code). The final object is validated with the
 * current SystemModelSchema; anything that fails is reported, never
 * half-loaded.
 */
import { domainRegistry } from "@/model/domain";
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

/**
 * v2 -> v3. MIGRATION CREATES NO KNOWLEDGE CLAIM:
 *  - a variable's subject is UNASSIGNED (null) unless the active domain
 *    declares its key system-scope, in which case the system id is the
 *    only possible subject (the key is defined as one-per-system);
 *  - every non-calculated relationship becomes "unclassified" and no
 *    relationship participates in dynamics; the person opts edges in;
 *  - income earner ids, constraint/action/hypothesis subjects are null;
 *  - stored signature snapshots keep the system as their subject: they
 *    were computed over household keys, which is a fact about how they
 *    were made, not a claim about a person.
 */
export function migrateV2toV3(v2: Raw, options: { systemScopeKeys?: ReadonlySet<string> } = {}): Raw {
  const systemId = typeof v2.id === "string" ? v2.id : "";
  const systemScopeKeys = options.systemScopeKeys ?? new Set<string>();
  const variables = asArray(v2.variables).map((v) => {
    const id = typeof v.id === "string" ? v.id : "";
    const key = typeof v.key === "string" && v.key ? v.key : id;
    const isDerived = v.kind === "derived";
    let subjectId: string | null = null;
    if (v.subjectId === null || typeof v.subjectId === "string") subjectId = (v.subjectId as string | null) ?? null;
    if (subjectId === null && (isDerived || systemScopeKeys.has(key))) subjectId = systemId;
    return { ...v, key, subjectId };
  });
  const relationships = asArray(v2.relationships).map((r) => {
    if (typeof r.kind === "string" && typeof r.participatesInDynamics === "boolean") return r; // already v3-shaped
    const kind = r.sourceType === "calculated" ? "definitional" : "unclassified";
    return { ...r, kind, participatesInDynamics: false };
  });
  const incomeSources = asArray(v2.incomeSources).map((s) => ({ ...s, earnerId: s.earnerId ?? null }));
  const constraints = asArray(v2.constraints).map((c) => ({ ...c, subjectId: c.subjectId ?? null }));
  const actions = asArray(v2.actions).map((a) => ({ ...a, subjectId: a.subjectId ?? null, extensions: a.extensions ?? {} }));
  const hypotheses = asArray(v2.hypotheses).map((h) => ({
    ...h,
    subjectId: h.subjectId ?? null,
    disconfirmingConditions: h.disconfirmingConditions ?? [],
    predictions: h.predictions ?? [],
    reviewLog: h.reviewLog ?? [],
    killCriteria: h.killCriteria ?? [],
  }));
  const signatures = asArray(v2.signatures).map((sig) => ({ ...sig, subjectId: sig.subjectId ?? systemId }));
  const { signatureDefinitionId: _dropped, ...rest } = v2;
  void _dropped;
  return {
    ...rest,
    schemaVersion: 3,
    domainDefinitionId: typeof v2.domainDefinitionId === "string" ? v2.domainDefinitionId : "household",
    domainDefinitionVersion: typeof v2.domainDefinitionVersion === "number" ? v2.domainDefinitionVersion : 1,
    variables,
    relationships,
    incomeSources,
    constraints,
    actions,
    hypotheses,
    signatures,
    events: v2.events ?? [],
  };
}

/**
 * v3 -> v4: value and target HISTORY. Each input currentValue becomes ONE
 * value entry and each desiredValue ONE target entry. NO HISTORY IS
 * INVENTED: the entry's `valid` is the instant the record was last saved
 * (`updatedAt`, else the migration instant) with `validBasis: "recorded"`,
 * meaning "known from here on; when it began is not recorded". Earlier
 * as-of queries resolve to unknown. A null currentValue / desiredValue
 * stays unknown and gets no entry. Derived variables become shells (no
 * value entries; their targets migrate). Everything else is untouched.
 */
export function migrateV3toV4(v3: Raw, options: { migratedAt?: string } = {}): Raw {
  const migratedAt = options.migratedAt ?? new Date().toISOString();
  const recordedAt = typeof v3.updatedAt === "string" && !Number.isNaN(Date.parse(v3.updatedAt)) ? v3.updatedAt : migratedAt;
  const valid = { kind: "instant", start: recordedAt, precision: "datetime", text: `as recorded ${recordedAt.slice(0, 10)}` };
  const note = "Migrated from schema v3: the value as known when the record was last saved. When it began is not recorded.";
  const variables = asArray(v3.variables).map((v) => {
    if (Array.isArray(v.values) && Array.isArray(v.targets)) return v; // already v4-shaped
    const { currentValue, desiredValue, sourceType, confidence, ...rest } = v;
    const id = typeof v.id === "string" ? v.id : "";
    const isDerived = v.kind === "derived";
    const values: Raw[] = [];
    if (!isDerived && typeof currentValue === "number") {
      values.push({
        id: `${id}__v1`,
        value: currentValue,
        valid,
        validBasis: "recorded",
        recordedAt,
        sourceType: typeof sourceType === "string" ? sourceType : "unknown",
        confidence: typeof confidence === "number" ? confidence : 0,
        evidence: [],
        observationIds: [],
        note,
        status: "active",
      });
    }
    const targets: Raw[] = [];
    if (typeof desiredValue === "number") {
      targets.push({
        id: `${id}__t1`,
        desiredValue,
        targetMode: typeof v.targetMode === "string" ? v.targetMode : "exact",
        valid,
        validBasis: "recorded",
        recordedAt,
        note: "Migrated from schema v3: the target as known when the record was last saved.",
        status: "active",
      });
    }
    return { ...rest, values, targets };
  });
  return { ...v3, schemaVersion: 4, variables };
}

/**
 * A migration step refusing its input: the record is not the shape that
 * version's contract promised, so the step has no defined transformation
 * for it. `migrateModel` turns it into the ordinary failure result; the
 * repository and the importer then store nothing.
 */
export class MigrationStepError extends Error {
  constructor(
    readonly fromVersion: number,
    message: string,
  ) {
    super(`Migration v${fromVersion} -> v${fromVersion + 1} refused: ${message}`);
    this.name = "MigrationStepError";
  }
}

/**
 * v4 -> v5: domain-owned COLLECTIONS. Until v4 every model carried a
 * universal `incomeSources` field. Dispatch is by schemaVersion only.
 *  CASE A  the record's registered domain declares "incomeSources"
 *          -> collections.incomeSources = { items, origin: "domain" }
 *  CASE B  the domain does not declare it (or is unregistered) and the
 *          field is empty -> the obsolete field is dropped; no collection
 *  CASE C  the domain does not declare it (or is unregistered) and the
 *          field holds records -> preserved verbatim under the same name
 *          with origin "legacy_universal": never evaluated, never edited
 *          through typed tools, exported and imported as is, never a
 *          reason to call the model invalid.
 * Event links `incomeSourceIds` become collectionItemRefs to
 * "incomeSources", verbatim, in every case. Nothing else is touched.
 *
 * SHAPE CONTRACT (no silent sanitization): corrupt v4 data is not
 * permission to drop or repair it. The step validates the shape of every
 * field it reads or reconstructs against the v4 contract, transforms only
 * those, preserves everything else, and REFUSES (MigrationStepError)
 * anything present but malformed. Absence is honoured only where v4 made
 * the field optional:
 *   incomeSources            required array in v4  -> absent or non-array: refused
 *   events                   default [] in v4      -> absent: []; non-array: refused
 *   events[i]                object                -> non-object entry: refused
 *   events[i].links          default {} in v4      -> absent: {}; non-object: refused
 *   links.incomeSourceIds    default [] of strings -> absent: []; non-array or
 *                                                     non-string entry: refused
 *   collections, links.collectionItemRefs          -> v5 fields; present on a v4
 *                                                     record: refused (the step
 *                                                     would otherwise merge or
 *                                                     overwrite them)
 * Item contents are never interpreted here; the final v5 validation
 * judges them (a non-object item or a missing id fails the whole record).
 */
export function migrateV4toV5(v4: Raw, options: { declaredCollections?: ReadonlySet<string> } = {}): Raw {
  const refuse = (message: string): never => {
    throw new MigrationStepError(4, message);
  };
  const declared = options.declaredCollections ?? new Set<string>();
  if ("collections" in v4) refuse('a schema-v4 record must not carry a "collections" field');
  const { incomeSources: rawItems, ...rest } = v4;
  if (!("incomeSources" in v4)) refuse('"incomeSources" is missing (schema v4 required it)');
  if (!Array.isArray(rawItems)) refuse(`"incomeSources" must be an array, got ${describeShape(rawItems)}`);
  const items = rawItems as unknown[];
  const collections: Raw = {};
  if (declared.has("incomeSources")) {
    collections.incomeSources = { items, origin: "domain" };
  } else if (items.length > 0) {
    collections.incomeSources = {
      items,
      origin: "legacy_universal",
      note: "Preserved from the schema-v4 universal incomeSources field. This domain does not declare it; the records are kept but not evaluated.",
    };
  }
  const rawEvents = v4.events === undefined ? [] : v4.events;
  if (!Array.isArray(rawEvents)) refuse(`"events" must be an array, got ${describeShape(rawEvents)}`);
  const events = (rawEvents as unknown[]).map((e, i) => {
    if (!isRecord(e)) refuse(`events[${i}] must be an object, got ${describeShape(e)}`);
    const event = e as Raw;
    const rawLinks = event.links === undefined ? {} : event.links;
    if (!isRecord(rawLinks)) refuse(`events[${i}].links must be an object, got ${describeShape(rawLinks)}`);
    const links = rawLinks as Raw;
    if ("collectionItemRefs" in links) refuse(`events[${i}].links must not carry "collectionItemRefs" on a schema-v4 record`);
    const { incomeSourceIds, ...otherLinks } = links;
    const legacy = incomeSourceIds === undefined ? [] : incomeSourceIds;
    if (!Array.isArray(legacy)) refuse(`events[${i}].links.incomeSourceIds must be an array, got ${describeShape(legacy)}`);
    (legacy as unknown[]).forEach((id, j) => {
      if (typeof id !== "string") refuse(`events[${i}].links.incomeSourceIds[${j}] must be a string, got ${describeShape(id)}`);
    });
    return { ...event, links: { ...otherLinks, collectionItemRefs: (legacy as string[]).map((id) => ({ collection: "incomeSources", id })) } };
  });
  return { ...rest, schemaVersion: 5, collections, events };
}

/**
 * v5 -> v6: hypothesis confidence may be "not assessed" (null). This is a
 * RELAXATION, so the step first enforces the v5 contract on every
 * hypothesis it meets: `confidence` present, a finite number, 0 <= c <= 1.
 * Valid v5 knowledge is preserved EXACTLY (0.5 stays 0.5: it may have been
 * chosen); malformed v5 data (missing, null, string, out of range) is
 * refused, never laundered into a valid v6 "not assessed". Nothing else is
 * read or changed. `hypotheses` defaulted to [] in v5, so absence is [].
 */
export function migrateV5toV6(v5: Raw): Raw {
  const refuse = (message: string): never => {
    throw new MigrationStepError(5, message);
  };
  const raw = v5.hypotheses === undefined ? [] : v5.hypotheses;
  if (!Array.isArray(raw)) refuse(`"hypotheses" must be an array, got ${describeShape(raw)}`);
  const hypotheses = (raw as unknown[]).map((h, i) => {
    if (!isRecord(h)) refuse(`hypotheses[${i}] must be an object, got ${describeShape(h)}`);
    const rec = h as Raw;
    if (!("confidence" in rec)) refuse(`hypotheses[${i}].confidence is missing (schema v5 required a number)`);
    const c: unknown = rec.confidence;
    if (typeof c !== "number" || !Number.isFinite(c)) refuse(`hypotheses[${i}].confidence must be a finite number, got ${describeShape(c)}`);
    const n = c as number;
    if (n < 0 || n > 1) refuse(`hypotheses[${i}].confidence must be between 0 and 1, got ${n}`);
    return rec;
  });
  return { ...v5, schemaVersion: 6, hypotheses };
}

function describeShape(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "an array";
  return typeof x === "object" ? "an object" : typeof x === "string" ? `the string ${JSON.stringify(x)}` : `a ${typeof x}`;
}

export interface MigrationOptions {
  /** Keys the domain declares system-scope; everything else stays unassigned. */
  systemScopeKeys?: ReadonlySet<string>;
  /** Clock for the v3 -> v4 step (tests pass a fixed instant). */
  migratedAt?: string;
  /** Collections the record's REGISTERED domain declares (v4 -> v5). An
   *  unregistered domain declares nothing, so its income data is
   *  preserved as legacy. */
  declaredCollections?: ReadonlySet<string>;
}

/**
 * The migration options a stored record's REGISTERED domain implies: its
 * system-scope keys (v2 -> v3) and its declared collections (v4 -> v5).
 * Records that predate domain ids (schema 1-2) are household records by
 * construction, so a missing `domainDefinitionId` resolves to "household".
 * An unregistered domain implies nothing: nothing is attributed to the
 * system scope and no collection is interpreted, only preserved.
 * `extra` (e.g. the clock) is merged on top.
 */
export function migrationOptionsFor(raw: unknown, extra: MigrationOptions = {}): MigrationOptions {
  const rec = isRecord(raw) ? raw : {};
  const domainId = typeof rec.domainDefinitionId === "string" ? rec.domainDefinitionId : "household";
  const version = typeof rec.domainDefinitionVersion === "number" ? rec.domainDefinitionVersion : undefined;
  const domain = domainRegistry.get(domainId, version);
  if (!domain) return { ...extra };
  return {
    systemScopeKeys: new Set(domain.variables.filter((v) => v.scope === "system").map((v) => v.key)),
    declaredCollections: new Set((domain.collections ?? []).map((c) => c.name)),
    ...extra,
  };
}

const STEPS: Record<number, (raw: Raw, options: MigrationOptions) => Raw> = {
  1: (raw) => migrateV1toV2(raw),
  2: (raw, options) => migrateV2toV3(raw, options),
  3: (raw, options) => migrateV3toV4(raw, options),
  4: (raw, options) => migrateV4toV5(raw, options),
  5: (raw) => migrateV5toV6(raw),
};

export function migrateModel(input: unknown, options: MigrationOptions = {}): MigrationResult {
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
    try {
      raw = step(raw, options);
    } catch (e) {
      // A step that refuses its input is an ordinary failure: nothing is
      // stored. Any other exception is a bug and propagates unchanged.
      if (e instanceof MigrationStepError) return { ok: false, error: e.message };
      throw e;
    }
    version += 1;
  }
  const parsed = SystemModelSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Migrated model failed validation: ${parsed.error.message}` };
  return { ok: true, model: parsed.data, migratedFrom: from === MODEL_SCHEMA_VERSION ? null : from };
}
