// PR 3C-2C-A — durable contract for migration 017 and quote-token v2.
//
// This suite deliberately does not connect to Supabase. Instead, it makes the
// migration carry an executable, transactional behavioral smoke and a complete
// emergency rollback, and pins the security/lifecycle contract those SQL
// sections must prove when Andres runs the migration in production.
//
// Run: node tests/quote-enforcement-foundation.test.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const migrationPath = path.join(
  repoRoot,
  'database/migrations/017_quote_enforcement_foundation.sql'
);
const preflightPath = path.join(
  repoRoot,
  'database/migrations/017_quote_enforcement_preflight.sql'
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const sql = migration.replace(/--[^\n]*/g, '');
const preflight = fs.readFileSync(preflightPath, 'utf8');
const preflightSql = preflight.replace(/--[^\n]*/g, '');

const {
  QUOTE_TTL_MS,
  MAX_CLOCK_SKEW_MS,
  computeCommitment,
  newJti,
  signQuoteToken,
  verifyQuoteToken
} = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));

const ACTIVE_STATUSES = [
  'pending',
  'confirmed',
  // Retained historical state: old rows may still carry it even though
  // current accept flow moves directly from pending to confirmed.
  'assigned',
  'on_the_way',
  'arrived',
  'in_progress'
];
const TABLES = [
  'pricing_state',
  'pricing_state_audit',
  'quote_acceptances',
  'quote_verifications',
  'operation_receipts'
];
const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER'
];

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message || String(error)}`);
    failures.push({ name, error });
  }
}

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function quotedValues(value) {
  return [...value.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function sameSet(actual, expected, message) {
  assert.deepStrictEqual([...new Set(actual)].sort(), [...expected].sort(), message);
}

function functionSql(name) {
  const startPattern = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${name}\\s*\\(`,
    'i'
  );
  const match = startPattern.exec(sql);
  assert.ok(match, `${name}() must exist`);
  const bodyStart = sql.indexOf('AS $$', match.index);
  assert.ok(bodyStart !== -1, `${name}() must use a visible dollar-quoted body`);
  const end = sql.indexOf('$$;', bodyStart);
  assert.ok(end !== -1, `${name}() body must terminate`);
  return sql.slice(match.index, end + 3);
}

function sectionAfter(marker) {
  const at = migration.indexOf(marker);
  assert.ok(at !== -1, `migration must contain ${marker}`);
  return migration.slice(at);
}

function uncommentSqlBlock(value) {
  return value.replace(/^\s*--\s?/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function assertBefore(haystack, earlier, later, message) {
  const first = haystack.search(earlier);
  const second = haystack.search(later);
  assert.ok(first !== -1, `${message}: missing earlier boundary`);
  assert.ok(second !== -1, `${message}: missing later boundary`);
  assert.ok(first < second, message);
}

function normalizeSqlType(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parameterTypes(value, declarations) {
  if (value.trim() === '') return [];
  return value.split(',').map((raw) => {
    const parameter = raw.trim().replace(/\s+DEFAULT\s+[\s\S]*$/i, '');
    if (!declarations) return normalizeSqlType(parameter);
    const match = /^(?:IN\s+|OUT\s+|INOUT\s+|VARIADIC\s+)?[A-Za-z_][A-Za-z0-9_]*\s+([\s\S]+)$/i.exec(parameter);
    assert.ok(match, `cannot normalize function parameter ${parameter}`);
    return normalizeSqlType(match[1]);
  });
}

function createdFoundationFunctionIdentities(value) {
  const names = new Set([
    'pricing_state_guard', 'set_pricing_mode', 'bookings_guard',
    'accept_quote_create', 'accept_quote_edit', 'accept_optional_edit'
  ]);
  const identities = [];
  const pattern = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*RETURNS\b/gi;
  for (const match of value.matchAll(pattern)) {
    if (!names.has(match[1])) continue;
    identities.push(`${match[1]}(${parameterTypes(match[2], true).join(',')})`);
  }
  return identities;
}

function droppedFoundationFunctionIdentities(value) {
  const names = new Set([
    'pricing_state_guard', 'set_pricing_mode', 'bookings_guard',
    'accept_quote_create', 'accept_quote_edit', 'accept_optional_edit'
  ]);
  const identities = [];
  const pattern = /DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gi;
  for (const match of value.matchAll(pattern)) {
    if (!names.has(match[1])) continue;
    identities.push(`${match[1]}(${parameterTypes(match[2], false).join(',')})`);
  }
  return identities;
}

function makeTokenFixture() {
  const secret = 'foundation-test-secret-0123456789abcdef0123456789';
  const keyId = 'foundation-v2';
  const nowMs = Date.UTC(2026, 7, 22, 12, 0, 0);
  const intent = {
    mode: 'dropoff',
    airportCode: 'MIA',
    placeId: 'ChIJFoundationAddress123',
    pickupAtMs: nowMs + 60 * 60 * 1000,
    passengers: 2,
    routeMilesTenths: 214,
    routeMinutes: 37
  };
  const createFields = {
    purpose: 'create',
    jti: newJti(),
    authUserId: '55555555-5555-4555-8555-555555555555',
    customerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    vehicle: 'escalade',
    pickupAtMs: intent.pickupAtMs,
    commitment: computeCommitment(intent, 'escalade', 17500, secret),
    routeQuality: 'traffic_aware',
    finalCents: 17500,
    pricingVersion: 'card-v1',
    engineVersion: 'engine-v1',
    resolvedVersion: 'card-v1'
  };
  const expected = {
    purpose: 'create',
    authUserId: createFields.authUserId,
    customerId: createFields.customerId,
    vehicle: createFields.vehicle,
    intent
  };
  return { secret, keyId, nowMs, intent, createFields, expected };
}

console.log('Quote-enforcement foundation contract');

(async () => {
  await check('migration stays atomic and reloads PostgREST before live COMMIT', () => {
    const liveCommit = sql.search(/\bCOMMIT\s*;/i);
    assert.ok(/^\s*BEGIN\s*;/i.test(sql), 'migration must begin one transaction');
    assert.ok(liveCommit > 0, 'migration must commit');
    const notify = sql.search(/NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;/i);
    assert.ok(notify > 0 && notify < liveCommit, 'schema reload must execute before COMMIT');
  });

  await check('emergency rollback is complete, transactional, and reloads schema', () => {
    const rollback = normalize(uncommentSqlBlock(sectionAfter('EMERGENCY ROLLBACK')));
    assert.match(rollback, /\bBEGIN\s*;/i);
    assert.match(rollback, /DROP TRIGGER(?: IF EXISTS)? bookings_guard_trg ON bookings/i);
    assert.match(rollback, /DROP INDEX(?: IF EXISTS)? bookings_one_active_per_customer/i);
    for (const fn of [
      'accept_quote_create',
      'accept_quote_edit',
      'accept_optional_edit',
      'set_pricing_mode',
      'bookings_guard',
      'pricing_state_guard'
    ]) {
      assert.match(rollback, new RegExp(`DROP FUNCTION(?: IF EXISTS)? ${fn}\\s*\\(`, 'i'));
    }
    for (const table of [
      'quote_acceptances',
      'quote_verifications',
      'operation_receipts',
      'pricing_state_audit',
      'pricing_state'
    ]) {
      assert.match(rollback, new RegExp(`DROP TABLE(?: IF EXISTS)? ${table}\\b`, 'i'));
    }
    for (const column of [
      'price_cents',
      'price_authority',
      'multi_booking_exempt',
      'active_slot',
      'assignment_epoch',
      'canonical_place_id',
      'airport_code',
      'route_authority'
    ]) {
      assert.match(rollback, new RegExp(`DROP COLUMN(?: IF EXISTS)? ${column}\\b`, 'i'));
    }
    assert.doesNotMatch(rollback, /DROP EXTENSION(?: IF EXISTS)? pgcrypto/i,
      'rollback must not remove a shared extension');
    assert.match(rollback, /NOTIFY pgrst\s*,\s*'reload schema'\s*;/i);
    assert.match(rollback, /ALTER COLUMN price DROP NOT NULL/i,
      'rollback must restore the pre-017 nullable price contract');
    assert.match(rollback, /to_regclass\(\s*'public\.pricing_state'\s*\)/i,
      'rollback must prove the state table is gone');
    assert.match(rollback, /pg_proc[\s\S]{0,300}proname\s+IN/i,
      'rollback must prove every function overload is gone');
    assert.match(rollback, /information_schema\.columns[\s\S]{0,300}price_cents/i,
      'rollback must prove every added bookings column is gone');
    assert.match(rollback, /pg_constraint[\s\S]{0,420}bookings_price_authority_check/i,
      'rollback must prove every added constraint is gone');
    assert.match(rollback, /pg_trigger[\s\S]{0,420}pricing_state_truncate_guard_trg/i,
      'rollback must prove every added trigger is gone');
    assert.match(rollback, /attname\s*=\s*'price'[\s\S]{0,80}attnotnull/i,
      'rollback must prove legacy price is nullable again');

    const created = createdFoundationFunctionIdentities(sql);
    const dropped = droppedFoundationFunctionIdentities(rollback);
    assert.strictEqual(created.length, 6,
      'migration must create exactly six foundation function identities');
    assert.strictEqual(dropped.length, 6,
      'rollback must drop exactly six foundation function identities');
    assert.deepStrictEqual(created.slice().sort(), dropped.slice().sort(),
      'rollback DROP signatures must exactly cover every created foundation function identity');
    assert.match(rollback, /\bCOMMIT\s*;/i);
  });

  await check('production preflight is DB-enforced read-only and detects every partial artifact', () => {
    assert.match(preflightSql, /^\s*BEGIN\s*;/i);
    assert.match(preflightSql, /SET\s+TRANSACTION\s+READ\s+ONLY\s*;/i);
    assert.match(preflightSql, /ROLLBACK\s*;\s*$/i);
    assert.doesNotMatch(preflightSql,
      /\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+(?:TABLE|FUNCTION|TRIGGER|INDEX)|DROP\s+)\b/i,
      'preflight must contain no mutation even inside its read-only transaction');
    for (const artifact of [
      'pricing_state', 'pricing_state_audit', 'quote_acceptances',
      'quote_verifications', 'operation_receipts',
      'accept_quote_create', 'accept_quote_edit', 'accept_optional_edit',
      'set_pricing_mode', 'bookings_guard', 'pricing_state_guard',
      'bookings_guard_trg', 'pricing_state_guard_trg',
      'pricing_state_truncate_guard_trg',
      'pricing_state_audit_guard_trg',
      'pricing_state_audit_truncate_guard_trg',
      'bookings_price_authority_check', 'bookings_route_authority_check',
      'bookings_route_identity_check', 'bookings_price_cents_equal_check',
      'bookings_price_nonnegative_check', 'bookings_assignment_epoch_check'
    ]) {
      assert.ok(preflight.includes(artifact), `preflight omits partial artifact ${artifact}`);
    }
    assert.match(preflightSql, /JOIN\s+public\.bookings\s+b\s+ON\s+b\.customer_id\s*=\s*c\.id/i,
      'ambassador candidates must be booked customers, exactly like the migration manifest');
    assert.doesNotMatch(preflightSql, /LEFT\s+JOIN\s+public\.bookings/i,
      'host-linked customers with zero bookings are not migration candidates');
    assert.match(preflightSql,
      /SELECT\s+column_name\s*,\s*is_nullable[\s\S]{0,220}column_name\s*=\s*'price'/i,
      'preflight must detect a manually altered legacy price-nullability contract');
    assert.match(preflightSql,
      /to_regprocedure\(\s*'extensions\.digest\(text,text\)'\s*\)/i,
      'preflight must prove pgcrypto digest exists in the trusted extensions schema');
    assert.match(preflight,
      /NULL::BOOLEAN\),\s*--\s*REVIEW TRUE\/FALSE/i,
      'preflight must generate a deliberately incomplete human-decision manifest');
    assert.match(preflight,
      /execute each labeled check A1 through G6 separately/i,
      'SQL-editor execution guidance must preserve every preflight result grid');
    const beginCount = (preflightSql.match(/\bBEGIN\s*;/gi) || []).length;
    const readOnlyCount = (preflightSql.match(/SET\s+TRANSACTION\s+READ\s+ONLY\s*;/gi) || []).length;
    const rollbackCount = (preflightSql.match(/\bROLLBACK\s*;/gi) || []).length;
    assert.strictEqual(beginCount, 16,
      'preflight must expose exactly 16 independently runnable result grids');
    assert.strictEqual(readOnlyCount, beginCount,
      'every preflight result grid must run inside a read-only transaction');
    assert.strictEqual(rollbackCount, beginCount,
      'every preflight result grid must close its own transaction');
  });

  await check('pgcrypto is a pre-existing qualified dependency, not rollback residue', () => {
    assert.doesNotMatch(sql, /CREATE\s+EXTENSION/i,
      '017 must not install shared infrastructure its rollback cannot remove');
    assert.match(sql,
      /pg_extension[\s\S]{0,220}extname\s*=\s*'pgcrypto'[\s\S]{0,160}nspname\s*=\s*'extensions'/i,
      'migration must require pgcrypto in the trusted extensions schema');
    assert.doesNotMatch(sql, /encode\s*\(\s*digest\s*\(/i,
      'SECURITY DEFINER code must never resolve an unqualified digest');
    assert.match(sql, /encode\s*\(\s*extensions\.digest\s*\(/i,
      'schema-qualified digest must be exercised');
  });

  await check('every production active-status predicate uses the exact lifecycle set', () => {
    const smokeAt = sql.search(/BEHAVIORAL\s+SMOKE/i);
    const productionSql = smokeAt === -1 ? sql : sql.slice(0, smokeAt);
    const matches = [...productionSql.matchAll(/\bstatus\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi)];
    assert.ok(matches.length >= 3, 'active-slot logic must repeat the explicit status boundary');
    for (const match of matches) {
      sameSet(quotedValues(match[1]), ACTIVE_STATUSES,
        `status predicate drifted: ${match[0]}`);
    }
  });

  await check('money and duplicate preflight refuse rather than fabricate history', () => {
    const preflight = normalize(migration.slice(
      migration.indexOf('0. Pre-flight'),
      migration.indexOf('1. bookings columns')
    ));
    assert.match(preflight, /bookings WHERE price IS NULL/i);
    assert.match(preflight, /price[^;]{0,300}(integer|2147483647|cents)/i,
      'preflight must refuse a historical fare that cannot become INTEGER cents');
    assert.match(preflight, /price\s*<\s*0/i,
      'migration preflight itself must reject negative historical money');
    assert.match(sql, /bookings_price_nonnegative_check\s+CHECK/i,
      'the durable table invariant must reject unsafe money');
    assert.match(preflight, /GROUP BY b\.customer_id HAVING count\(\*\) > 1/i);
    assert.match(preflight, /RAISE EXCEPTION/i);
  });

  await check('historical ambassador classification is explicit and exact-set checked', () => {
    const anchor = migration.search(
      /CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\s+migration_017_ambassador_decisions/i
    );
    assert.ok(anchor !== -1, 'reviewed historical decision table must exist');
    const raw = migration.slice(anchor);
    assert.match(raw,
      /CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\s+migration_017_ambassador_decisions\s*\(\s*customer_id\s+UUID\s+PRIMARY\s+KEY\s*,\s*multi_booking_exempt\s+BOOLEAN\s+NOT\s+NULL\s*\)/i);
    assert.match(uncommentSqlBlock(raw),
      /INSERT\s+INTO\s+migration_017_ambassador_decisions\s*\(\s*customer_id\s*,\s*multi_booking_exempt\s*\)/i,
      'the reviewed decision anchor must be present even before production UUIDs are populated');
    assert.match(raw, /JOIN\s+hosts\s+h\s+ON\s+h\.user_id\s*=\s*c\.user_id/i,
      'candidate discovery must include every host-linked historical customer');
    assert.doesNotMatch(
      normalize(raw.slice(0, raw.search(/1\. bookings columns/i) === -1 ? raw.length : raw.search(/1\. bookings columns/i))),
      /h\.status\s*=\s*'active'/i,
      'historical classification must not silently erase inactive former hosts');
    const excepts = raw.match(/\bEXCEPT\b/gi) || [];
    assert.ok(excepts.length >= 2,
      'candidate and decision UUID sets must be compared in both directions');
    assert.match(raw, /COALESCE\s*\([^)]*multi_booking_exempt[^)]*,\s*FALSE\s*\)/is,
      'all non-reviewed customers must default to non-exempt');

    const lockAt = sql.search(
      /LOCK\s+TABLE\s+public\.bookings\s*,\s*public\.customers\s*,\s*public\.hosts\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE\s+NOWAIT\s*;/i
    );
    const manifestCheckAt = sql.search(/SELECT\s+count\(\*\)\s+INTO\s+v_actor_missing/i);
    const backfillAt = sql.search(/UPDATE\s+bookings\s+b\s+SET\s+multi_booking_exempt/i);
    assert.ok(lockAt !== -1, 'migration must freeze bookings/customers/hosts without waiting');
    assert.ok(lockAt < manifestCheckAt && manifestCheckAt < backfillAt,
      'actor-set locks must precede exact-set validation and historical backfill');
  });

  await check('acceptance purpose and operation kinds are closed exact sets', () => {
    const acceptance = /purpose\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*purpose\s+IN\s*\(([^)]*)\)/i.exec(sql);
    const receipt = /kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i.exec(sql);
    assert.ok(acceptance, 'quote acceptance purpose constraint must exist');
    assert.ok(receipt, 'operation receipt kind constraint must exist');
    sameSet(quotedValues(acceptance[1]), ['create', 'edit']);
    sameSet(quotedValues(receipt[1]), ['create', 'edit_optional', 'edit_quoted']);
  });

  await check('token v2 refuses purpose confusion and separates authenticity from time', () => {
    const { secret, keyId, nowMs, intent, createFields, expected } = makeTokenFixture();
    const token = signQuoteToken(createFields, { keyId, secret, nowMs });
    const keys = [{ id: keyId, secret }];
    assert.strictEqual(
      verifyQuoteToken(token, {
        keys,
        nowMs,
        expected: { ...expected, purpose: 'edit' }
      }).reason,
      'wrong_purpose'
    );
    assert.strictEqual(
      verifyQuoteToken(token, { keys, nowMs: nowMs + QUOTE_TTL_MS, expected }).reason,
      'expired'
    );
    const deferred = verifyQuoteToken(token, {
      keys,
      nowMs: nowMs + QUOTE_TTL_MS,
      expected,
      deferTime: true
    });
    assert.strictEqual(deferred.ok, true, 'deferred expiry preserves authentic projection');
    assert.strictEqual(deferred.timeStatus, 'expired');
    assert.strictEqual(deferred.canConsume, false, 'an expired token cannot create a new consumption');
  });

  await check('token signer and verifier reject clocks, nil identities, and SQL overflows', () => {
    const { secret, keyId, nowMs, intent, createFields, expected } = makeTokenFixture();
    const token = signQuoteToken(createFields, { keyId, secret, nowMs });
    const keys = [{ id: keyId, secret }];
    const rawCreate = {
      v: 2,
      kid: keyId,
      jti: createFields.jti,
      purpose: 'create',
      authUserId: createFields.authUserId,
      customerId: createFields.customerId,
      vehicle: createFields.vehicle,
      pickupAtMs: createFields.pickupAtMs,
      commitment: createFields.commitment,
      routeQuality: createFields.routeQuality,
      finalCents: createFields.finalCents,
      pricingVersion: createFields.pricingVersion,
      engineVersion: createFields.engineVersion,
      resolvedVersion: createFields.resolvedVersion,
      iat: nowMs,
      exp: nowMs + QUOTE_TTL_MS
    };
    const forge = (payload) => {
      const canonical = JSON.stringify(payload);
      return `${Buffer.from(canonical).toString('base64url')}.${crypto
        .createHmac('sha256', secret).update(canonical).digest('base64url')}`;
    };

    assert.throws(
      () => signQuoteToken(createFields, { keyId, secret, nowMs: nowMs + 0.5 }),
      /invalid clock/i
    );
    assert.deepStrictEqual(
      verifyQuoteToken(token, { keys, nowMs: nowMs + 0.5, expected }),
      { ok: false, reason: 'invalid_clock' }
    );

    for (const [field, value] of [
      ['jti', '00000000-0000-0000-0000-000000000000'],
      ['authUserId', '00000000-0000-0000-0000-000000000000'],
      ['customerId', '00000000-0000-0000-0000-000000000000']
    ]) {
      assert.throws(
        () => signQuoteToken({ ...createFields, [field]: value }, { keyId, secret, nowMs }),
        /invalid create payload/i,
        `${field} must refuse the nil UUID`
      );
      assert.strictEqual(
        verifyQuoteToken(forge({ ...rawCreate, [field]: value }), { keys, nowMs, expected }).reason,
        'schema_invalid',
        `verifier must refuse ${field}'s nil UUID before key/time work`
      );
    }

    const editFields = {
      ...createFields,
      purpose: 'edit',
      bookingId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      assignmentEpoch: 0
    };
    assert.throws(
      () => signQuoteToken({
        ...editFields,
        bookingId: '00000000-0000-0000-0000-000000000000'
      }, { keyId, secret, nowMs }),
      /invalid edit payload/i
    );
    const rawEdit = {
      v: 2,
      kid: keyId,
      jti: editFields.jti,
      purpose: 'edit',
      authUserId: editFields.authUserId,
      customerId: editFields.customerId,
      bookingId: editFields.bookingId,
      assignmentEpoch: editFields.assignmentEpoch,
      vehicle: editFields.vehicle,
      pickupAtMs: editFields.pickupAtMs,
      commitment: editFields.commitment,
      routeQuality: editFields.routeQuality,
      finalCents: editFields.finalCents,
      pricingVersion: editFields.pricingVersion,
      engineVersion: editFields.engineVersion,
      resolvedVersion: editFields.resolvedVersion,
      iat: nowMs,
      exp: nowMs + QUOTE_TTL_MS
    };
    const editExpected = { ...expected, purpose: 'edit' };
    assert.strictEqual(
      verifyQuoteToken(forge({
        ...rawEdit,
        bookingId: '00000000-0000-0000-0000-000000000000'
      }), { keys, nowMs, expected: editExpected }).reason,
      'schema_invalid'
    );
    assert.throws(
      () => signQuoteToken({ ...editFields, assignmentEpoch: 2147483648 }, { keyId, secret, nowMs }),
      /invalid edit payload/i
    );
    assert.strictEqual(
      verifyQuoteToken(forge({ ...rawEdit, assignmentEpoch: 2147483648 }), {
        keys, nowMs, expected: editExpected
      }).reason,
      'schema_invalid'
    );
    assert.throws(
      () => signQuoteToken({
        ...createFields,
        finalCents: 2147483648,
        commitment: computeCommitment(intent, createFields.vehicle, 2147483648, secret)
      }, { keyId, secret, nowMs }),
      /invalid create payload/i
    );
    assert.strictEqual(
      verifyQuoteToken(forge({ ...rawCreate, finalCents: 2147483648 }), {
        keys, nowMs, expected
      }).reason,
      'schema_invalid'
    );
    assert.throws(
      () => signQuoteToken({ ...createFields, pickupAtMs: 8640000000000001 }, { keyId, secret, nowMs }),
      /invalid create payload/i
    );
    assert.strictEqual(
      verifyQuoteToken(forge({ ...rawCreate, pickupAtMs: 8640000000000001 }), {
        keys, nowMs, expected
      }).reason,
      'schema_invalid'
    );
  });

  await check('commitment intent is integer-exact and invalid input never gets signed', () => {
    const { secret, keyId, nowMs, intent, createFields, expected } = makeTokenFixture();
    assert.throws(
      () => computeCommitment({ ...intent, routeMilesTenths: 10.5 }, 'escalade', 17500, secret),
      /invalid input/i
    );
    assert.throws(
      () => computeCommitment(null, 'escalade', 17500, secret),
      /invalid input/i
    );
    assert.throws(
      () => computeCommitment(intent, '', 17500, secret),
      /invalid input/i
    );
    const token = signQuoteToken(createFields, { keyId, secret, nowMs });
    assert.strictEqual(
      verifyQuoteToken(token, {
        keys: [{ id: keyId, secret }],
        nowMs,
        expected: { ...expected, intent: { ...intent, routeMilesTenths: 10.5 } }
      }).reason,
      'invalid_expectation'
    );
  });

  await check('a hand-built weak verifier key refuses as unknown_key without throwing', () => {
    const { nowMs, intent, createFields, expected } = makeTokenFixture();
    const weakSecret = 'weak';
    const weakKeyId = 'weak-key';
    const payload = {
      v: 2,
      kid: weakKeyId,
      jti: createFields.jti,
      purpose: 'create',
      authUserId: createFields.authUserId,
      customerId: createFields.customerId,
      vehicle: createFields.vehicle,
      pickupAtMs: createFields.pickupAtMs,
      commitment: 'a'.repeat(64),
      routeQuality: createFields.routeQuality,
      finalCents: createFields.finalCents,
      pricingVersion: createFields.pricingVersion,
      engineVersion: createFields.engineVersion,
      resolvedVersion: createFields.resolvedVersion,
      iat: nowMs,
      exp: nowMs + QUOTE_TTL_MS
    };
    const canonical = JSON.stringify(payload);
    const token = `${Buffer.from(canonical).toString('base64url')}.${crypto
      .createHmac('sha256', weakSecret).update(canonical).digest('base64url')}`;
    assert.doesNotThrow(() => verifyQuoteToken(token, {
      keys: [{ id: weakKeyId, secret: weakSecret }],
      nowMs,
      expected: { ...expected, intent }
    }));
    assert.strictEqual(
      verifyQuoteToken(token, {
        keys: [{ id: weakKeyId, secret: weakSecret }],
        nowMs,
        expected: { ...expected, intent }
      }).reason,
      'unknown_key'
    );
  });

  await check('SQL token time policy is pinned to the shared JavaScript constants', () => {
    const bodies = [functionSql('accept_quote_create'), functionSql('accept_quote_edit')];
    for (const [index, body] of bodies.entries()) {
      const ttl = [...body.matchAll(/\(p_payload->>'exp'\)::NUMERIC\s*-\s*\(p_payload->>'iat'\)::NUMERIC\s*<>\s*(\d+)/gi)]
        .map((match) => Number(match[1]));
      const skew = [...body.matchAll(/\(p_payload->>'iat'\)::BIGINT\s*>\s*v_now_ms\s*\+\s*(\d+)/gi)]
        .map((match) => Number(match[1]));
      assert.ok(ttl.length >= 1, `RPC ${index + 1} must enforce exact TTL`);
      assert.ok(skew.length >= 1, `RPC ${index + 1} must enforce maximum clock skew`);
      sameSet(ttl, [QUOTE_TTL_MS], `RPC ${index + 1} TTL drifted from quote-token.js`);
      sameSet(skew, [MAX_CLOCK_SKEW_MS], `RPC ${index + 1} skew drifted from quote-token.js`);
    }
  });

  await check('both RPCs enforce verdict shape and purpose-bound exact retries', () => {
    assert.match(migration,
      /authentic token as verdict `verified`[\s\S]{0,180}never relabel it `verify_failed`/i,
      'the endpoint/RPC handoff must preserve authentic stale-token provenance');
    const create = normalize(functionSql('accept_quote_create'));
    const edit = normalize(functionSql('accept_quote_edit'));
    for (const body of [create, edit]) {
      const verdict = /p_verdict\s+NOT\s+IN\s*\(([^)]*)\)/i.exec(body);
      assert.ok(verdict, 'RPC must reject an unknown verifier verdict');
      sameSet(quotedValues(verdict[1]), ['verified', 'no_token', 'verify_failed']);
      assertBefore(body, /WHERE\s+token_digest\s*=\s*p_token_digest/i,
        /WHERE\s+jti\s*=\s*p_jti/i,
        'exact-token retry must precede sibling-jti handling');
      assertBefore(body, /token_digest\s*=\s*p_token_digest/i,
        /v_mode\s*=\s*'enforce'\s+AND\s+p_verdict\s*<>\s*'verified'/i,
        'exact-token retry must precede the new-consumption time/verdict refusal');
      assert.match(body,
        /p_verdict\s*=\s*'no_token'[\s\S]{0,240}p_token_digest\s+IS\s+NOT\s+NULL/i,
        'no_token must reject a presented digest');
      assert.match(body,
        /p_verdict\s*=\s*'verify_failed'[\s\S]{0,200}p_token_digest\s+IS\s+NULL/i,
        'verify_failed must retain a digest but no verified projection');
      assert.match(body,
        /p_verdict\s*=\s*'verified'\s+AND\s+v_effective_verdict\s*<>\s*'verified'/i,
        'authentic stale/future tokens must be refused in every mode');
      assert.doesNotMatch(body,
        /v_mode\s*=\s*'enforce'\s+AND\s+v_effective_verdict\s*<>\s*'verified'/i,
        'time refusal must not be enforce-only');
      assert.match(body, /pg_advisory_xact_lock\s*\(/i,
        'same-operation retries must serialize before receipt creation');

      const receiptWrite = body.lastIndexOf('INSERT INTO operation_receipts');
      const finalClock = body.lastIndexOf(
        'v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT'
      );
      const rollbackRaise = body.indexOf("RAISE EXCEPTION USING ERRCODE = 'ZQ017'", finalClock);
      const rollbackHandler = body.indexOf("EXCEPTION WHEN SQLSTATE 'ZQ017'", rollbackRaise);
      assert.ok(receiptWrite !== -1 && finalClock > receiptWrite &&
        rollbackRaise > finalClock && rollbackHandler > rollbackRaise,
      'a final post-wait clock guard must roll back business writes before refusing');
    }
    assert.match(create, /v_accept\.purpose\s*=\s*'create'/i,
      'a create RPC must not accept an edit-token digest as an idempotent create');
    assert.match(edit, /v_accept\.purpose\s*=\s*'edit'/i);
    assert.match(edit, /v_accept\.booking_id\s*=\s*p_booking_id/i);
    const rowLock = edit.search(/SELECT\s+\*\s+INTO\s+v_row[\s\S]{0,80}FOR\s+UPDATE/i);
    const clocks = [...edit.matchAll(/v_now_ms\s*:=\s*floor\(extract\(epoch\s+FROM\s+clock_timestamp\(\)\)/gi)]
      .map((match) => match.index);
    assert.ok(rowLock !== -1 && clocks.some((index) => index > rowLock),
      'quoted edit must repeat its clock check after the row lock');
  });

  await check('canonical airport and vehicle are cross-bound at the RPC boundary', () => {
    const create = normalize(functionSql('accept_quote_create'));
    const edit = normalize(functionSql('accept_quote_edit'));
    for (const body of [create, edit]) {
      assert.match(body, /p_airport_code\s+TEXT/i);
      assert.match(body, /p_vehicle_key\s+TEXT/i);
      assert.match(body, /p_payload->>'vehicle'\s+IS\s+DISTINCT\s+FROM\s+p_vehicle_key/i);
      assert.match(body, /p_airport_code\s+NOT\s+IN\s*\(\s*'MIA'\s*,\s*'FLL'\s*,\s*'PBI'\s*\)/i);
      assert.match(body, /p_vehicle_key\s+NOT\s+IN\s*\(\s*'tesla'\s*,\s*'escalade'\s*,\s*'sprinter'\s*\)/i);
      assert.match(body, /CASE\s+p_vehicle_key[\s\S]{0,240}'Tesla Model Y'/i,
        'stored vehicle fields must derive from the canonical key');
    }
  });

  await check('both quoted RPCs reject semantically invalid time and money', () => {
    for (const name of ['accept_quote_create', 'accept_quote_edit']) {
      const body = normalize(functionSql(name));
      assert.match(body, /jsonb_typeof\(p_payload->'iat'\)\s+IS\s+DISTINCT\s+FROM\s+'number'/i,
        `${name} must type-check iat`);
      assert.match(body, /jsonb_typeof\(p_payload->'exp'\)\s+IS\s+DISTINCT\s+FROM\s+'number'/i,
        `${name} must type-check exp`);
      assert.match(body, /jsonb_typeof\(p_payload->'finalCents'\)\s+IS\s+DISTINCT\s+FROM\s+'number'/i,
        `${name} must type-check finalCents`);
      assert.match(body, /'finalCents'\)::NUMERIC\s+<>\s+trunc/i,
        `${name} must reject fractional money`);
      assert.match(body, /'finalCents'\)::NUMERIC\s+>\s+2147483647/i,
        `${name} must reject money outside the SQL range`);
      assert.strictEqual(
        (body.match(/verified payload has invalid time or money semantics/gi) || []).length,
        1,
        `${name} must carry exactly one semantic guard`
      );
    }
  });

  await check('full edits downgrade unverified identity and retain the validated ETA snapshot', () => {
    const edit = normalize(functionSql('accept_quote_edit'));
    assert.match(edit,
      /canonical_place_id\s*=\s*CASE\s+WHEN\s+v_effective_verdict\s*=\s*'verified'\s+AND\s+v_mode\s*<>\s*'off'[\s\S]{0,180}THEN\s+p_canonical_place_id\s+ELSE\s+NULL\s+END/i);
    assert.match(edit,
      /airport_code\s*=\s*CASE\s+WHEN\s+v_effective_verdict\s*=\s*'verified'\s+AND\s+v_mode\s*<>\s*'off'[\s\S]{0,180}THEN\s+p_airport_code\s+ELSE\s+NULL\s+END/i);
    assert.match(edit,
      /route_authority\s*=\s*CASE\s+WHEN\s+v_effective_verdict\s*=\s*'verified'\s+AND\s+v_mode\s*<>\s*'off'[\s\S]{0,180}THEN\s+'canonical'\s+ELSE\s+'legacy_text'\s+END/i);
    assert.match(edit,
      /duration_minutes\s*=\s*v_duration_minutes/i,
      'the whole-minute passenger/ops ETA snapshot must use the validated edit value');
    assert.match(edit,
      /v_duration_minutes\s*<\s*1\s+OR\s+v_duration_minutes\s*>\s*1440/i,
      'the temporarily retained duration must be bounded before storage');
    assert.doesNotMatch(edit, /route_(?:miles|distance)[A-Za-z_]*\s*=/i,
      'authoritative route distance stays commitment-only and unstored');

    const guard = normalize(functionSql('bookings_guard'));
    assert.match(guard,
      /NEW\.pickup_location\s+IS\s+DISTINCT\s+FROM\s+OLD\.pickup_location[\s\S]{0,320}NEW\.canonical_place_id\s*:=\s*NULL[\s\S]{0,160}NEW\.route_authority\s*:=\s*'legacy_text'/i,
      'a direct legacy route edit must downgrade stale canonical identity');
  });

  await check('pricing mode transition graph is explicit and exhaustive', () => {
    const body = normalize(functionSql('set_pricing_mode'));
    const expected = {
      off: ['off', 'observe'],
      observe: ['off', 'observe', 'enforce'],
      enforce: ['enforce', 'blocked'],
      blocked: ['blocked', 'enforce']
    };
    const branches = [...body.matchAll(
      /v_state\.mode\s*=\s*'([^']+)'\s+AND\s+p_mode\s+IN\s*\(([^)]*)\)/gi
    )];
    assert.strictEqual(branches.length, 4, 'transition function must spell out four source modes');
    const bySource = Object.fromEntries(
      branches.map((match) => [match[1], quotedValues(match[2])])
    );
    for (const [from, to] of Object.entries(expected)) {
      assert.ok(bySource[from], `${from} transition boundary must be explicit`);
      sameSet(bySource[from], to, `${from} transition targets drifted`);
    }
    assert.match(body,
      /enforcement_started_at\s+IS\s+NOT\s+NULL[\s\S]{0,180}p_mode\s+IN\s*\(\s*'off'\s*,\s*'observe'\s*\)/i,
      'high-water mark must reject reopening browser-priced modes');

    const allowed = (from, to) => expected[from].includes(to);
    const actualPairs = [];
    for (const from of Object.keys(expected)) {
      for (const to of Object.keys(expected)) {
        if (allowed(from, to)) actualPairs.push(`${from}->${to}`);
      }
    }
    sameSet(actualPairs, [
      'off->off', 'off->observe',
      'observe->off', 'observe->observe', 'observe->enforce',
      'enforce->enforce', 'enforce->blocked',
      'blocked->blocked', 'blocked->enforce'
    ]);
  });

  await check('all foundation tables are RLS-on with zero client policies', () => {
    for (const table of TABLES) {
      assert.match(sql,
        new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'));
    }
    assert.match(sql, /pg_class[\s\S]{0,500}relrowsecurity/i,
      'self-check must verify RLS, not merely issue ALTER statements');
    assert.match(sql, /pg_policies/i, 'self-check must count policies');
    assert.match(sql, /polic(?:y|ies)[\s\S]{0,240}(?:<>|>|!=)\s*0/i,
      'any client-facing policy must abort the migration');
  });

  await check('ACL self-check covers all table/column privileges and client roles', () => {
    assert.match(sql, /has_table_privilege/i);
    assert.match(sql, /has_column_privilege/i);
    for (const privilege of TABLE_PRIVILEGES) {
      assert.match(sql, new RegExp(`['\"]${privilege}['\"]`, 'i'),
        `${privilege} privilege must be checked explicitly`);
    }
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.match(migration, new RegExp(`\\b${role}\\b`, 'i'));
    }
    assert.match(sql, /GRANT\s+SELECT\s+ON[\s\S]{0,300}TO\s+service_role/i);
    assert.match(sql, /GRANT\s+INSERT\s+ON\s+quote_verifications\s+TO\s+service_role/i);
    assert.doesNotMatch(sql,
      /GRANT\s+INSERT\s+ON\s+operation_receipts\s+TO\s+service_role/i,
      'receipts must be written only with their atomic RPC result');
    const ceiling = normalize(migration.slice(migration.indexOf('Service-role ceiling:')));
    for (const privilege of TABLE_PRIVILEGES) {
      assert.match(ceiling,
        new RegExp(`has_table_privilege\\(\\s*'service_role'[^)]*'${privilege}'`, 'i'),
        `service-role ceiling must check ${privilege}`);
    }
  });

  await check('identity sequences have an explicit least-privilege ceiling', () => {
    assert.match(sql,
      /REVOKE\s+ALL\s+ON\s+SEQUENCE[\s\S]{0,260}pricing_state_audit_id_seq[\s\S]{0,260}quote_verifications_id_seq[\s\S]{0,180}service_role/i);
    assert.match(sql,
      /GRANT\s+USAGE\s+ON\s+SEQUENCE\s+quote_verifications_id_seq\s+TO\s+service_role/i);
    assert.doesNotMatch(sql,
      /GRANT\s+(?:USAGE|SELECT|UPDATE)(?:\s*,\s*(?:USAGE|SELECT|UPDATE))*\s+ON\s+SEQUENCE\s+pricing_state_audit_id_seq\s+TO\s+service_role/i,
      'service_role must not write the audit identity sequence outside its definer RPC');
    assert.match(sql, /has_sequence_privilege/i,
      'migration must verify the effective sequence privileges');
  });

  await check('definer RPCs pin search_path and client EXECUTE stays revoked', () => {
    for (const fn of [
      'set_pricing_mode', 'accept_quote_create', 'accept_quote_edit', 'accept_optional_edit'
    ]) {
      const body = normalize(functionSql(fn));
      assert.match(body, /SECURITY DEFINER SET search_path\s*=\s*public\s*,\s*extensions\s*,\s*pg_temp/i);
      assert.match(sql,
        new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${fn}\\s*\\([\\s\\S]{0,300}?FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated`, 'i'));
      assert.match(sql,
        new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${fn}\\s*\\([\\s\\S]{0,300}?TO\\s+service_role`, 'i'));
    }
    const bookingsGuard = normalize(functionSql('bookings_guard'));
    assert.match(bookingsGuard,
      /LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*public\s*,\s*pg_temp/i,
      'bookings guard must read pricing_state under owner rights with a pinned path');
  });

  await check('exactly five guard triggers and the active-slot index are verified', () => {
    const expectedTriggers = [
      'bookings_guard_trg',
      'pricing_state_guard_trg',
      'pricing_state_truncate_guard_trg',
      'pricing_state_audit_guard_trg',
      'pricing_state_audit_truncate_guard_trg'
    ];
    const createdTriggers = [...sql.matchAll(/CREATE\s+TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((match) => match[1]);
    assert.strictEqual(createdTriggers.length, 5,
      'migration must create exactly five triggers, with no duplicate hiding behind set comparison');
    sameSet(createdTriggers, expectedTriggers,
      'migration must create exactly the five reviewed guard triggers');
    assert.match(sql, /CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+bookings_one_active_per_customer/i);
    for (const trigger of expectedTriggers) {
      assert.match(sql, new RegExp(`pg_trigger[\\s\\S]{0,900}${trigger}`, 'i'),
        `self-check must name ${trigger}`);
    }
    assert.match(sql, /tgenabled/i, 'self-check must refuse a disabled trigger');
    assert.match(sql, /v_count\s*<>\s*5/i,
      'self-check must require exactly five enabled foundation triggers');
    assert.match(sql, /pg_indexes[\s\S]{0,300}bookings_one_active_per_customer/i);
  });

  await check('behavioral smoke exercises both RPCs, legacy writes, eras, slots, and mode valve', () => {
    const smokeRaw = sectionAfter('BEHAVIORAL SMOKE');
    const rollbackAt = smokeRaw.indexOf('EMERGENCY ROLLBACK');
    const bounded = rollbackAt === -1 ? smokeRaw : smokeRaw.slice(0, rollbackAt);
    const smoke = normalize(bounded.replace(/--[^\n]*/g, ''));
    assert.match(smoke, /accept_quote_create\s*\(/i);
    assert.match(smoke, /accept_quote_edit\s*\(/i);
    assert.match(smoke, /accept_optional_edit\s*\(/i);
    assert.match(smoke, /set_pricing_mode\s*\(/i);
    assert.match(smoke, /INSERT\s+INTO\s+bookings/i,
      'compatibility smoke must exercise a direct legacy insert');
    assert.match(smoke, /UPDATE\s+bookings/i,
      'compatibility smoke must exercise assignment/status/edit trigger behavior');
    assert.match(smoke, /active_slot/i);
    assert.match(smoke, /assignment_epoch/i);
    assert.match(smoke, /idempotent|replay/i);
    assert.match(smoke, /quote_consumed/i);
    assert.match(smoke, /version_conflict|details_version/i);
    assert.match(smoke, /enforce/i);
    assert.match(smoke, /blocked/i);
    assert.match(smoke, /quote_not_yet_valid/i,
      'observe smoke must refuse a future token before business writes');
    assert.match(smoke, /off verified acceptance\/duration contract failed/i,
      'off smoke must consume a valid quote under client_legacy authority');
    assert.match(smoke, /off sibling token multiplied one quote/i,
      'off smoke must prove acceptance—not active_slot—prevents quote multiplication');
    assert.match(smoke, /off accepted an authentic stale edit quote/i,
      'off smoke must refuse authentic stale edits without relabelling them');
    assert.match(smoke, /active_exists/i,
      'smoke must classify the RPC active-slot conflict');
    assert.match(smoke, /SET\s+LOCAL\s+ROLE\s+service_role/i,
      'smoke must execute the service-role telemetry insertion path');
    assert.match(smoke, /service_role fabricated an operation receipt/i,
      'smoke must prove the service role cannot invent receipts');
    assert.match(smoke, /blocked-optional-smoke/i,
      'contact-only edits must remain usable during a pricing emergency');
    assert.match(smoke, /legacy route edit retained stale canonical identity/i,
      'smoke must exercise direct-writer canonical-identity downgrade');
  });

  await check('service-role smoke performs real booking insert, accept, and cancellation writes', () => {
    const smokeRaw = sectionAfter('BEHAVIORAL SMOKE');
    const roleBlock = /EXECUTE\s+'SET LOCAL ROLE service_role'\s*;([\s\S]*?)EXECUTE\s+'RESET ROLE'\s*;/i.exec(smokeRaw);
    assert.ok(roleBlock, 'smoke must have a bounded service_role block');
    assert.match(roleBlock[1], /INSERT\s+INTO\s+bookings\b/i,
      'service_role must exercise the real legacy create lane');
    assert.match(roleBlock[1],
      /UPDATE\s+bookings\s+SET\s+status\s*=\s*'confirmed'\s*,\s*assigned_driver\s*=\s*v_driver/i,
      'service_role must exercise driver acceptance');
    assert.match(roleBlock[1],
      /UPDATE\s+bookings\s+SET\s+status\s*=\s*'cancelled'/i,
      'service_role must exercise passenger cancellation');
    assert.match(smokeRaw,
      /legacy assigned writer escaped authority\/actor\/slot guards/i,
      'the role-scoped writes must be asserted after RESET ROLE');
  });

  await check('enforce smoke proves server money wins and direct pricing writes are fenced', () => {
    const smokeRaw = sectionAfter('BEHAVIORAL SMOKE');
    const rollbackAt = smokeRaw.indexOf('EMERGENCY ROLLBACK');
    const smoke = normalize((rollbackAt === -1 ? smokeRaw : smokeRaw.slice(0, rollbackAt))
      .replace(/--[^\n]*/g, ''));
    assert.match(smoke,
      /accept_quote_create[\s\S]{0,700}1\.00[\s\S]{0,600}price\s*=\s*132\.00[\s\S]{0,160}price_cents\s*=\s*13200/i,
      'enforce create must prove browser money loses to token money');
    assert.match(smoke,
      /accept_quote_edit[\s\S]{0,700}2\.00[\s\S]{0,600}price\s*=\s*145\.00[\s\S]{0,160}price_cents\s*=\s*14500/i,
      'enforce edit must prove browser money loses to token money');
    assert.match(smoke, /enforce create did not use server money/i);
    assert.match(smoke, /enforce edit did not use server money/i);
    assert.match(smoke, /RPC authority mismatch was accepted/i,
      'smoke must reject an RPC-marked write whose authority disagrees with the mode');
    assert.match(smoke, /customer_id accepted a direct write/i,
      'smoke must exercise the customer immutability guard without relying on slot uniqueness');
    assert.match(smoke, /direct INSERT survived enforcement/i);
    assert.match(smoke, /direct ride-intent UPDATE survived enforcement/i);
    assert.match(smoke, /enforce edit accepted no token/i);
    assert.match(smoke, /enforce accepted an invalid token/i);
  });

  await check('smoke outcome assertions cannot pass vacuously on SQL NULL', () => {
    const smokeRaw = sectionAfter('BEHAVIORAL SMOKE');
    const rollbackAt = smokeRaw.indexOf('EMERGENCY ROLLBACK');
    const smoke = (rollbackAt === -1 ? smokeRaw : smokeRaw.slice(0, rollbackAt))
      .replace(/--[^\n]*/g, '');
    assert.doesNotMatch(smoke, /v_result\s*(?:->>\s*'[^']+'\s*)?<>/i,
      'v_result comparisons must use IS DISTINCT FROM so NULL fails closed');
    assert.match(smoke, /v_result->>'outcome'\s+IS\s+DISTINCT\s+FROM/i,
      'smoke must carry explicit NULL-safe outcome assertions');
  });

  await check('smoke teardown proves no bookings, actors, receipts, or quote rows survive', () => {
    const smokeRaw = sectionAfter('BEHAVIORAL SMOKE');
    const rollbackAt = smokeRaw.indexOf('EMERGENCY ROLLBACK');
    const bounded = rollbackAt === -1 ? smokeRaw : smokeRaw.slice(0, rollbackAt);
    const smoke = normalize(bounded.replace(/--[^\n]*/g, ''));
    for (const table of [
      'quote_acceptances',
      'quote_verifications',
      'operation_receipts',
      'bookings',
      'customers',
      'hosts'
    ]) {
      assert.match(smoke, new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i'),
        `smoke teardown must clean ${table}`);
    }
    assert.match(smoke, /smoke residue/i,
      'final residue assertion must be explicit and searchable');
    assert.match(smoke, /pricing_state_audit/i,
      'smoke must compare the transition-audit row count before and after');
    assert.match(smoke, /setval\s*\(\s*'public\.pricing_state_audit_id_seq'/i);
    assert.match(smoke, /setval\s*\(\s*'public\.quote_verifications_id_seq'/i);
    assert.match(smoke,
      /pricing_state[\s\S]{0,240}mode\s*=\s*'off'[\s\S]{0,120}enforcement_started_at\s+IS\s+NULL/i,
      'smoke must prove mode/high-water returned to their pre-smoke state');
    assert.match(smoke, /RAISE\s+EXCEPTION\s+USING\s+ERRCODE\s*=\s*'ZZ017'/i,
      'the behavioral mutations must be contained by an intentional subtransaction rollback');
    assertBefore(smoke, /smoke residue/i, /NOTIFY\s+pgrst/i,
      'residue must be proven before schema reload and COMMIT');
  });

  if (failures.length > 0) {
    const summary = failures.map(({ name }) => name).join('; ');
    throw new Error(`${failures.length} foundation contract check(s) failed: ${summary}`);
  }
  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
