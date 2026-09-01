// R1 — new-write route-content non-retention (migration 018 + envelope).
//
// Run: node tests/r1-route-content.test.js
//
// Layer 1 (SQL text): migration 018 replaces the two live writers IN PLACE.
// These assertions pin the exact contract: same signatures (no overload),
// SECURITY DEFINER + search_path preserved, verified writes no longer
// require duration, duration is never persisted, and the acceptance
// projection is a fail-closed allowlist that excludes routeQuality.
//
// Layer 2 (rollback): 018_r1_rollback.sql must restore the 017 bodies
// BYTE-EXACTLY — asserted by extracting both from the real files and
// comparing, not by trusting a comment.
//
// Layer 3 (STATIC, labelled honestly): the browser envelope and endpoint
// wiring pins that the behavioral suites cannot reach.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const m017 = fs.readFileSync(path.join(repoRoot, 'database/migrations/017_quote_enforcement_foundation.sql'), 'utf8');
const m018 = fs.readFileSync(path.join(repoRoot, 'database/migrations/018_r1_route_content_non_retention.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(repoRoot, 'database/migrations/018_r1_rollback.sql'), 'utf8');
const indexMvp = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
const netlifyToml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
const createBooking = fs.readFileSync(path.join(repoRoot, 'backend/functions/create-booking.js'), 'utf8');
const updatePending = fs.readFileSync(path.join(repoRoot, 'backend/functions/update-pending-booking.js'), 'utf8');

function extract(src, name) {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf('$$;', start) + 3;
  return src.slice(start, end);
}
// The full header through RETURNS JSONB — a first-')' scan stops inside
// parameter comments (e.g. "(an UNVERIFIED jti"), making a post-comment
// parameter-type mutation invisible (Codex round-2 §5.5).
const signatureOf = (body) => {
  const end = body.indexOf(') RETURNS JSONB');
  assert.ok(end > 0, 'signature must end with ) RETURNS JSONB');
  return body.slice(0, end + ') RETURNS JSONB'.length);
};

let checks = 0;
const results = [];
function check(name, f) {
  try { f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message}`);
    results.forEach((x) => console.log(x));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

console.log('\nR1 — route-content non-retention contract\n');

const create017 = extract(m017, 'accept_quote_create');
const edit017 = extract(m017, 'accept_quote_edit');
const create018 = extract(m018, 'accept_quote_create');
const edit018 = extract(m018, 'accept_quote_edit');

check('signatures are byte-identical to 017 — CREATE OR REPLACE cannot create an overload', () => {
  assert.strictEqual(signatureOf(create018), signatureOf(create017));
  assert.strictEqual(signatureOf(edit018), signatureOf(edit017));
});

check('SECURITY DEFINER and SET search_path survive in both replacement bodies', () => {
  for (const body of [create018, edit018]) {
    assert.match(body, /SECURITY DEFINER/);
    assert.match(body, /SET search_path/);
  }
});

check('the verified-duration REQUIREMENT is gone from both writers', () => {
  assert.match(create017, /p_verdict = 'verified' AND v_duration_minutes IS NULL/,
    '017 baseline must contain the requirement this removes');
  assert.match(edit017, /v_effective_verdict = 'verified' AND v_duration_minutes IS NULL/);
  assert.ok(!/verified' AND v_duration_minutes IS NULL/.test(create018));
  assert.ok(!/verified' AND v_duration_minutes IS NULL/.test(edit018));
});

check('duration is never persisted: create writes NULL, edit CLEARS unconditionally', () => {
  assert.match(create018, /NULL::INTEGER,/, 'create must insert NULL for duration_minutes');
  assert.ok(!/VALUES[\s\S]*v_duration_minutes,/.test(create018.slice(create018.indexOf('INSERT INTO bookings'))),
    'create must not insert the submitted duration');
  assert.match(edit018, /duration_minutes = NULL,/);
  assert.ok(!/duration_minutes = v_duration_minutes/.test(edit018));
});

check('the 1..1440 band check on SUBMITTED duration is retained for input strictness', () => {
  for (const body of [create018, edit018]) {
    assert.match(body, /v_duration_minutes < 1 OR v_duration_minutes > 1440/);
  }
});

check('the acceptance projection is a fail-closed ALLOWLIST excluding routeQuality', () => {
  for (const [label, body, extraKeys] of [
    ['create', create018, []],
    ['edit', edit018, ['bookingId', 'assignmentEpoch']],
  ]) {
    // The body legitimately INSPECTS routeQuality while validating the
    // token schema (plan R1 permits transient inspection). The prohibition
    // is scoped to the PROJECTION: the jsonb_build_object block must not
    // name it, and the raw passthrough must be gone.
    // The bodies contain an EARLIER jsonb_build_object (the idempotent
    // receipt return), so the projection must be anchored specifically: the
    // first build-object AFTER the payload_projection column list. The first
    // version of this check anchored on the wrong one and scanned a
    // meaningless slice — caught by mutation testing, not review.
    const projStart = body.indexOf('jsonb_build_object(', body.indexOf('payload_projection'));
    assert.ok(projStart > 0, `${label}: projection must be built, not passed through`);
    const proj = body.slice(projStart, body.indexOf(')', body.indexOf("'exp'", projStart)) + 1);
    assert.ok(!/routeQuality/.test(proj), `${label}: routeQuality must not be named into the projection`);
    assert.ok(!/v_passengers,\s*\n\s*p_payload\s*\n\s*\)/.test(body),
      `${label}: the raw p_payload passthrough must be gone`);
    for (const key of ['commitment', 'finalCents', 'jti', 'pickupAtMs', ...extraKeys]) {
      assert.ok(body.includes(`'${key}', p_payload->'${key}'`), `${label}: projection must carry ${key}`);
    }
  }
  // 017 baseline really did pass the whole payload through
  assert.match(create017, /v_passengers,\s*\n\s*p_payload\s*\n\s*\);/);
});

check('018 self-verifies: overload count, SECURITY DEFINER, search_path, requirement gone, no routeQuality', () => {
  for (const marker of [
    'overload detected', 'SECURITY DEFINER was lost', 'search_path/config drifted',
    'verified-duration requirement is still present', 'routeQuality reached the persisted projection',
    'fail-closed projection allowlist is missing'
  ]) {
    assert.ok(m018.includes(marker), `self-verification must check: ${marker}`);
  }
  // and the projection check is PAIR-scoped, so the verify block cannot
  // abort against the bodies' own legitimate schema inspection
  assert.ok(m018.includes("LIKE '%''routeQuality'', p_payload%'"),
    'the self-check must target the projection pair, not any mention');
  assert.match(m018, /^BEGIN;/m);
  assert.match(m018, /^COMMIT;/m);
});

check('018 contains NO setval on any live sequence — smoke gaps are accepted, never rewound', () => {
  // Round-2 P1: a setval back to a snapshot races concurrent inserts and is
  // global/non-transactional. The smoke must consume-and-accept gaps.
  assert.ok(!/setval\(/.test(m018), '018 must never rewind a live sequence');
  assert.match(m018, /gaps are harmless and\n\s*-- accepted/i,
    'the deliberate no-restore decision must be stated where the restore used to be');
});

check('the ROLLBACK file restores the 017 bodies BYTE-EXACTLY', () => {
  assert.strictEqual(extract(rollback, 'accept_quote_create'), create017);
  assert.strictEqual(extract(rollback, 'accept_quote_edit'), edit017);
  assert.match(rollback, /^BEGIN;/m);
  assert.match(rollback, /^COMMIT;/m);
});

check('accept_optional_edit is untouched by 018, as documented', () => {
  assert.ok(!m018.includes('accept_optional_edit(') ||
    m018.indexOf('accept_optional_edit(') === m018.indexOf('accept_optional_edit is deliberately untouched'),
    '018 must not redefine accept_optional_edit');
  assert.ok(!/CREATE OR REPLACE FUNCTION accept_optional_edit/.test(m018));
});

// ---- Layer 3: STATIC wiring pins ----

check('STATIC: the persisted envelope carries identity metadata ONLY — never bodyString', () => {
  const store = indexMvp.slice(indexMvp.indexOf('storePendingEnvelope(envelope) {'));
  const body = store.slice(0, store.indexOf('\n            }'));
  assert.match(body, /operationId: envelope\.operationId/);
  assert.match(body, /createdAt: envelope\.createdAt/);
  assert.ok(!/bodyString/.test(body.slice(body.indexOf('const stored'))),
    'the stored object must not include bodyString');
  assert.match(body, /this\._liveEnvelope = envelope/,
    'the exact bytes stay in page memory for same-page retry');
});

check('STATIC: the post-reload Check-again path is the read-only lookup, never a writer POST', () => {
  const handler = indexMvp.slice(indexMvp.indexOf('let out;'), indexMvp.indexOf('let out;') + 2600);
  assert.match(handler, /if \(env\.bodyString\) \{/);
  assert.match(handler, /checkOperationStatus\(env, session\.access_token\)/);
  const statusBranch = handler.slice(handler.indexOf('} else {'), handler.indexOf('out = {'));
  assert.ok(!/create-booking|update-pending-booking/.test(statusBranch),
    'the no-bytes branch must never name a writer endpoint');
  assert.match(statusBranch, /120000/);
});

check('STATIC: checkOperationStatus POSTs /api/operation-status with the Bearer session', () => {
  const method = indexMvp.slice(indexMvp.indexOf('async checkOperationStatus(env, accessToken)'));
  const body = method.slice(0, method.indexOf('\n            }'));
  assert.match(body, /\/api\/operation-status/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /Bearer \$\{accessToken\}/);
  assert.ok(!/sessionStorage|localStorage/.test(body), 'the lookup touches no storage');
});

check('STATIC: netlify routes /api/operation-status to the function', () => {
  assert.match(netlifyToml, /from = "\/api\/operation-status"\s*\n\s*to = "\/\.netlify\/functions\/operation-status"/);
});

check('STATIC: neither writer endpoint forwards duration any more', () => {
  assert.ok(!/duration_minutes:\s*(?!null)/.test(createBooking.replace(/\/\/[^\n]*/g, '')) ||
    !/duration_minutes:/.test(createBooking.match(/const pBooking[\s\S]*?\n    \};/)?.[0] || ''),
    'create-booking must not put duration_minutes into pBooking');
  assert.match(updatePending, /delete pEdit\.duration_minutes;/);
  assert.ok(!/pEdit\.duration_minutes = /.test(updatePending),
    'update-pending-booking must never assign a duration into pEdit');
});

results.forEach((x) => console.log(x));
console.log(`\n  ALL ${checks} CHECKS PASS\n`);
