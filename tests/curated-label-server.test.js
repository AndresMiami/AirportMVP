// Curated cruise terminals — the SERVER side (plan v7 §4).
//
// Run: node tests/curated-label-server.test.js
//
// Runs the REAL create-booking and update-pending-booking handlers with
// @supabase/supabase-js mocked via require.cache (the repo pattern) and REAL
// v2 quote tokens minted through quote-token.js, so 'verified' is the real
// verifier's verdict. The RPC mock simulates accept_quote_create /
// accept_quote_edit's installed contract (ownership, pending+unassigned,
// details_version CAS, operation receipts).
//
// The rule under test: a booking stores LinkMia's unambiguous terminal label
// ONLY when its quote token verified AND the canonical place id is a
// verified terminal in data/curated-places.json — on the address side the
// booking_mode names. Every other verdict stores the client's text exactly
// as before. Edits add ONE pre-read that decides the label and nothing
// else: it never adds a refusal shape and never intercepts a retry.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.ADMIN_TELEGRAM_CHAT_ID;
const SECRET = 'curated-label-test-secret-0123456789abcdef0123456789';
const KID = 'cl1';
process.env.QUOTE_SIGNING_CURRENT_ID = KID;
process.env.QUOTE_SIGNING_CURRENT_SECRET = SECRET;
delete process.env.QUOTE_SIGNING_PREVIOUS_ID;
delete process.env.QUOTE_SIGNING_PREVIOUS_SECRET;

const repoRoot = path.resolve(__dirname, '..');
const { computeCommitment, newJti, signQuoteToken } = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));
const curatedLib = require(path.join(repoRoot, 'backend/functions/lib/curated-places.js'));

const AUTH = '11111111-2222-4333-8444-555566667777';
const CUST = '99999999-8888-4777-8666-555544443333';
const OTHER_CUST = '77777777-6666-4555-8444-333322221111';
const BID = 'aaaa1111-2222-4333-8444-555566667777';
const NEW_ID = 'bbbb2222-3333-4444-8555-666677778888';
const OP = '9f8e7d6c-5b4a-4321-8abc-def012345678';
const TERMINAL_V = 'ChIJO1Q7bLK12YgRyjFe2sYTfNc';
const TERMINAL_V_LABEL = 'PortMiami Terminal V, 718 N Cruise Blvd, Miami, FL 33132';
const BRAND_RESULT = 'ChIJh8T1SwC12YgRCr9Mz-5L6MA';   // "Virgin Voyages, Miami, FL" — a brand result, not a terminal
const FUTURE_MS = Date.now() + 48 * 3600e3;

// ---- supabase mock ----
let state;
function reset(bookingOverrides = {}) {
  state = {
    booking: {
      id: BID, trip_id: 'LM-EFFA', status: 'pending', assigned_driver: null, customer_id: CUST,
      details_version: 1, price: 100, payment_status: 'unpaid', payment_method: 'cash', host_commission: 0,
      created_at: '2026-10-26T18:00:00Z', referred_by_host: null, source: 'website',
      customer_email: 'pat@example.com', flight_number: null, notes: null, pickup_sign: null, promo_code: null,
      booker_name: null, booker_phone: null,
      // LM-EFFA as stored today: an airport PICKUP whose address side was
      // the brand result's bare label.
      booking_mode: 'pickup', airport_code: 'MIA', canonical_place_id: BRAND_RESULT, route_authority: 'canonical',
      pickup_location: 'Miami International Airport', dropoff_location: 'Miami, FL 33132, USA',
      pickup_datetime: new Date(FUTURE_MS).toISOString(), passengers: 2, bags: 1,
      vehicle_type: 'sedan', vehicle_name: 'Tesla Model Y', duration_minutes: null,
      customer_name: 'Pat Passenger', customer_phone: '+1 305 555 0100',
      ...bookingOverrides
    },
    createdRow: null,
    receipts: new Map(),
    rpcCalls: [],
    selects: [],
    writes: 0,
    preReadError: null,
    afterPreRead: null
  };
}

const EDIT_COLUMNS = ['pickup_location', 'dropoff_location', 'pickup_datetime', 'passengers', 'bags',
  'vehicle_type', 'vehicle_name', 'booking_mode', 'customer_name', 'customer_phone'];

const db = {
  rpc: async (name, args) => {
    state.rpcCalls.push({ name, args });
    if (name === 'accept_quote_create') {
      state.createdRow = { id: NEW_ID, trip_id: 'LM-NEW', status: 'pending', price: args.p_client_price,
        details_version: 1, ...args.p_booking, duration_minutes: null };
      state.writes++;
      return { data: { outcome: 'created', booking_id: NEW_ID, authority: args.p_verdict === 'verified' ? 'canonical' : 'client_legacy' }, error: null };
    }
    assert.strictEqual(name, 'accept_quote_edit');
    if (args.p_operation_request_id && state.receipts.has(args.p_operation_request_id)) {
      const r = state.receipts.get(args.p_operation_request_id);
      return { data: { outcome: 'idempotent', booking_id: r.bookingId, details_version: r.detailsVersion }, error: null };
    }
    const b = state.booking;
    if (!b || b.id !== args.p_booking_id || b.customer_id !== args.p_customer_id) return { data: { outcome: 'not_found' }, error: null };
    if (b.status !== 'pending' || b.assigned_driver) return { data: { outcome: 'not_editable' }, error: null };
    if (b.details_version !== args.p_expected_details_version) return { data: { outcome: 'version_conflict' }, error: null };
    const next = { ...b };
    for (const col of EDIT_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(args.p_edit, col)) next[col] = args.p_edit[col];
    }
    if (args.p_verdict === 'verified') {
      next.canonical_place_id = args.p_canonical_place_id;
      next.airport_code = args.p_airport_code;
      next.route_authority = 'canonical';
    }
    next.price = args.p_client_price;
    next.details_version = b.details_version + 1;
    state.booking = next;
    state.writes++;
    if (args.p_operation_request_id) {
      state.receipts.set(args.p_operation_request_id, { bookingId: next.id, detailsVersion: next.details_version });
    }
    return { data: { outcome: 'updated', booking_id: next.id, details_version: next.details_version }, error: null };
  },
  from(table) {
    if (table === 'customers') {
      return { select: () => ({ eq: (col, val) => ({ maybeSingle: async () => ({ data: val === AUTH ? { id: CUST } : null, error: null }) }) }) };
    }
    if (table === 'hosts') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'operation_receipts' || table === 'quote_acceptances') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    }
    if (table !== 'bookings') throw new Error('unexpected table ' + table);
    return {
      select(columns) {
        const filters = {};
        const cols = String(columns).split(',').map((s) => s.trim());
        const preRead = cols.includes('route_authority');
        const chain = {
          eq(col, val) { filters[col] = val; return chain; },
          in() { return chain; },
          order() { return chain; },
          limit() { return chain; },
          async maybeSingle() {
            state.selects.push({ cols, filters, preRead });
            if (preRead && state.preReadError) return { data: null, error: state.preReadError };
            let row = null;
            if (filters.id) {
              if (state.createdRow && filters.id === state.createdRow.id) row = state.createdRow;
              else if (state.booking && filters.id === state.booking.id) row = state.booking;
            }
            const data = row ? Object.fromEntries(cols.map((k) => [k, row[k]])) : null;
            if (preRead && state.afterPreRead) { const hook = state.afterPreRead; state.afterPreRead = null; hook(); }
            return { data, error: null };
          }
        };
        return chain;
      },
      insert() { throw new Error('direct bookings INSERT is forbidden — the RPC is the only writer'); },
      update() { throw new Error('direct bookings UPDATE is forbidden — the RPC is the only writer'); }
    };
  }
};
const supabaseMock = {
  createClient: (url, key) => key === 'anon-key'
    ? { auth: { getUser: async (token) => token === 'tok-pat'
        ? { data: { user: { id: AUTH, email: 'pat@example.com' } }, error: null }
        : { data: { user: null }, error: { status: 401, message: 'bad token' } } } }
    : db
};
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const createFn = require(path.join(repoRoot, 'backend/functions/create-booking.js'));
const editFn = require(path.join(repoRoot, 'backend/functions/update-pending-booking.js'));

// ---- real tokens ----
function intentFor({ mode = 'pickup', placeId = TERMINAL_V, passengers = 2 } = {}) {
  return { mode, airportCode: 'MIA', placeId, pickupAtMs: FUTURE_MS, passengers, routeMilesTenths: 123, routeMinutes: 25 };
}
function mint(purpose, intent, { vehicle = 'tesla', finalCents = 13200 } = {}) {
  const fields = {
    purpose, jti: newJti(), authUserId: AUTH, customerId: CUST, vehicle,
    pickupAtMs: intent.pickupAtMs, commitment: computeCommitment(intent, vehicle, finalCents, SECRET),
    routeQuality: 'traffic_aware', finalCents, pricingVersion: 'v1', engineVersion: 'e1', resolvedVersion: 'r1'
  };
  if (purpose === 'edit') Object.assign(fields, { bookingId: BID, assignmentEpoch: 0 });
  return signQuoteToken(fields, { keyId: KID, secret: SECRET, nowMs: Date.now() });
}
function contract(intent, token) {
  return token ? {
    quoteToken: token, placeId: intent.placeId, airportCode: intent.airportCode, vehicleKey: 'tesla',
    routeMilesTenths: intent.routeMilesTenths, routeMinutes: intent.routeMinutes
  } : {};
}
function createBody(intent, token, over = {}) {
  return {
    customerName: 'Pat Passenger', phone: '+1 305 555 0100', email: 'pat@example.com',
    pickup: 'Client pickup text', dropoff: 'Client dropoff text',
    dateTime: new Date(intent.pickupAtMs).toISOString(), vehicle: 'Tesla Model Y', price: 132,
    passengers: intent.passengers, bags: 2, mode: intent.mode, paymentMethod: 'cash', tripId: 'LM-TEST',
    operationId: OP, ...contract(intent, token), ...over
  };
}
function editBody(intent, token, over = {}) {
  return {
    bookingId: BID, expectedDetailsVersion: 1,
    customerName: 'Pat Passenger', phone: '+1 305 555 0100',
    pickup: 'Client pickup text', dropoff: 'Client dropoff text',
    dateTime: new Date(intent.pickupAtMs).toISOString(), vehicle: 'Tesla Model Y', price: 132,
    passengers: intent.passengers, bags: 1, mode: intent.mode, operationId: OP,
    ...contract(intent, token), ...over
  };
}
const post = (fn, body, token = 'tok-pat') => fn.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});
const lastRpc = () => state.rpcCalls[state.rpcCalls.length - 1].args;
const preReads = () => state.selects.filter((s) => s.preRead);

let passed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (error) {
    results.push(`  ✗ ${name}\n      ${error.message}`);
    results.forEach((line) => console.log(line));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

(async () => {
  console.log('\nCurated cruise terminals — server label projection\n');

  // ------------------------------------------------------------ create

  await check('create: a VERIFIED token for Terminal V on an airport DROPOFF stores the terminal label as the pickup; the client\'s text is ignored', async () => {
    reset();
    const intent = intentFor({ mode: 'dropoff' });
    const r = await post(createFn, createBody(intent, mint('create', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    const a = lastRpc();
    assert.strictEqual(a.p_verdict, 'verified');
    assert.strictEqual(a.p_canonical_place_id, TERMINAL_V);
    assert.strictEqual(a.p_booking.pickup_location, TERMINAL_V_LABEL);
    assert.strictEqual(a.p_booking.dropoff_location, 'Client dropoff text', 'the airport side is the client\'s text as before');
    assert.strictEqual(state.createdRow.pickup_location, TERMINAL_V_LABEL, 'the stored row carries the terminal label');
  });

  await check('create: on an airport PICKUP the terminal label lands on the dropoff side', async () => {
    reset();
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(createFn, createBody(intent, mint('create', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_booking.dropoff_location, TERMINAL_V_LABEL);
    assert.strictEqual(lastRpc().p_booking.pickup_location, 'Client pickup text');
  });

  await check('create: a verified NON-curated id (the brand result LM-EFFA picked, or an id Google replaced) stores the client\'s text', async () => {
    reset();
    const intent = intentFor({ mode: 'pickup', placeId: BRAND_RESULT });
    const r = await post(createFn, createBody(intent, mint('create', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_verdict, 'verified');
    assert.strictEqual(lastRpc().p_canonical_place_id, BRAND_RESULT);
    assert.strictEqual(lastRpc().p_booking.dropoff_location, 'Client dropoff text');
  });

  await check('create: the server adds nothing — a client-typed terminal name beside a non-terminal id is stored as plain client text (today\'s behaviour), identity stays the verified id', async () => {
    reset();
    const intent = intentFor({ mode: 'pickup', placeId: BRAND_RESULT });
    const r = await post(createFn, createBody(intent, mint('create', intent), { dropoff: TERMINAL_V_LABEL }));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_canonical_place_id, BRAND_RESULT);
    assert.strictEqual(lastRpc().p_booking.dropoff_location, TERMINAL_V_LABEL);
  });

  await check('create: no token -> no_token, client text, no projection (today\'s legacy path)', async () => {
    reset();
    const intent = intentFor({ mode: 'dropoff' });
    const r = await post(createFn, createBody(intent, null));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_verdict, 'no_token');
    assert.strictEqual(lastRpc().p_canonical_place_id, null);
    assert.strictEqual(lastRpc().p_booking.pickup_location, 'Client pickup text');
  });

  await check('create: a token that fails verification -> verify_failed, client text, no projection', async () => {
    reset();
    const intent = intentFor({ mode: 'dropoff' });
    const r = await post(createFn, createBody(intent, 'garbage.token'));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_verdict, 'verify_failed');
    assert.strictEqual(lastRpc().p_canonical_place_id, null);
    assert.strictEqual(lastRpc().p_booking.pickup_location, 'Client pickup text');
  });

  // -------------------------------------------------------------- edit

  await check('edit: identity CHANGED (LM-EFFA re-pointed from the brand result to Terminal V) -> the terminal label replaces the client\'s text on the address side', async () => {
    reset();
    const intent = intentFor({ mode: 'pickup' });   // stored canonical id is the brand result; the token binds Terminal V
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    const a = lastRpc();
    assert.strictEqual(a.p_verdict, 'verified');
    assert.strictEqual(a.p_edit.dropoff_location, TERMINAL_V_LABEL);
    assert.strictEqual(a.p_edit.pickup_location, 'Client pickup text', 'the airport side is untouched');
    assert.strictEqual(state.booking.dropoff_location, TERMINAL_V_LABEL);
    assert.strictEqual(preReads().length, 1, 'exactly one pre-read');
    assert.deepStrictEqual(preReads()[0].filters, { id: BID });
    assert.strictEqual(JSON.parse(r.body).booking.dropoff_location, TERMINAL_V_LABEL);
  });

  await check('edit: identity EQUAL (a time-only edit of a Terminal V booking) -> no projection; the client\'s round-tripped labels pass through untouched', async () => {
    reset({ canonical_place_id: TERMINAL_V, dropoff_location: TERMINAL_V_LABEL });
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(editFn, editBody(intent, mint('edit', intent), { dropoff: 'Whatever the client round-tripped' }));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Whatever the client round-tripped');
    assert.strictEqual(preReads().length, 1);
  });

  await check('edit: a LEGACY row\'s first verified edit counts as a change -> projected', async () => {
    reset({ route_authority: 'client_legacy', canonical_place_id: null, airport_code: null });
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, TERMINAL_V_LABEL);
  });

  await check('edit: a mode change (same terminal, now going TO the airport) moves the label to the other side', async () => {
    reset({ canonical_place_id: TERMINAL_V, dropoff_location: TERMINAL_V_LABEL });
    const intent = intentFor({ mode: 'dropoff' });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_edit.pickup_location, TERMINAL_V_LABEL);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text');
  });

  await check('edit: a FOREIGN booking gets no projection and the RPC\'s own refusal, unchanged', async () => {
    reset({ customer_id: OTHER_CUST });
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.ok(r.statusCode === 404 || r.statusCode === 403, `refused by the RPC's own shape, got ${r.statusCode}: ${r.body}`);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text', 'nothing projected for a row that is not the caller\'s');
    assert.strictEqual(state.writes, 0);
  });

  await check('edit: a version that already MOVED gets no projection and the RPC\'s own 409, unchanged', async () => {
    reset({ details_version: 2 });   // the client still expects 1
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 409, r.body);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text');
    assert.strictEqual(state.writes, 0);
  });

  await check('edit: a CONCURRENT commit between the pre-read and the RPC fails the RPC\'s CAS; the projected label is discarded with it', async () => {
    reset();
    state.afterPreRead = () => { state.booking = { ...state.booking, details_version: 2 }; };
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 409, r.body);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, TERMINAL_V_LABEL, 'the projection was computed against the pre-read row…');
    assert.strictEqual(state.writes, 0, '…and never written: the CAS refused the stale version');
    assert.strictEqual(state.booking.dropoff_location, 'Miami, FL 33132, USA');
  });

  await check('edit: an EXACT-BYTE RETRY after success lands on the receipt — one write, no re-projection, the stored label stands', async () => {
    reset();
    const intent = intentFor({ mode: 'pickup' });
    const body = editBody(intent, mint('edit', intent));
    const first = await post(editFn, body);
    assert.strictEqual(first.statusCode, 200, first.body);
    assert.strictEqual(state.writes, 1);
    assert.strictEqual(state.booking.dropoff_location, TERMINAL_V_LABEL);
    const second = await post(editFn, body);
    assert.strictEqual(second.statusCode, 200, second.body);
    assert.strictEqual(JSON.parse(second.body).idempotent, true, 'the receipt answered');
    assert.strictEqual(state.writes, 1, 'one write only');
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text', 'the retry\'s pre-read saw the moved version and projected nothing');
    assert.strictEqual(state.booking.dropoff_location, TERMINAL_V_LABEL);
    assert.strictEqual(JSON.parse(second.body).booking.dropoff_location, TERMINAL_V_LABEL);
  });

  await check('edit: a pre-read FAILURE skips projection and lets the RPC run with the client\'s text — never a new refusal', async () => {
    reset();
    state.preReadError = { code: 'XX000' };
    const intent = intentFor({ mode: 'pickup' });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text');
    assert.strictEqual(state.writes, 1);
  });

  await check('edit: a verified NON-curated id costs no pre-read at all', async () => {
    reset();
    const intent = intentFor({ mode: 'pickup', placeId: BRAND_RESULT });
    const r = await post(editFn, editBody(intent, mint('edit', intent)));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(preReads().length, 0);
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text');
  });

  await check('edit: no token and verify_failed keep today\'s behaviour — client text, no pre-read', async () => {
    const intent = intentFor({ mode: 'pickup' });
    reset();
    let r = await post(editFn, editBody(intent, null));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_verdict, 'no_token');
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text');
    assert.strictEqual(preReads().length, 0);
    reset();
    r = await post(editFn, editBody(intent, 'garbage.token'));
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(lastRpc().p_verdict, 'verify_failed');
    assert.strictEqual(lastRpc().p_edit.dropoff_location, 'Client dropoff text');
    assert.strictEqual(preReads().length, 0);
  });

  // ---------------------------------------------------------- packaging

  await check('packaging: both functions load the registry the browser uses, and project only from a VERIFIED canonical id', () => {
    assert.strictEqual(curatedLib.validation.ok, true, curatedLib.validation.errors.join('; '));
    assert.ok(curatedLib.findVerifiedTerminal(TERMINAL_V), 'Terminal V verified in the real registry');
    for (const file of ['backend/functions/create-booking.js', 'backend/functions/update-pending-booking.js']) {
      const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      assert.match(src, /require\('\.\/lib\/curated-places'\)/, `${file} requires the server lib statically (esbuild inlines it)`);
      assert.match(src, /verdict === 'verified' \? projectCuratedLabel\(canonicalPlaceId, /, `${file} projects only on a verified verdict, from the canonical id`);
    }
  });

  results.forEach((line) => console.log(line));
  // CI (.github/workflows/tests.yml) accepts a suite only on this exact
  // sentinel; it is printed only after every check above passed.
  console.log(`\n  ALL ${passed} CHECKS PASS\n`);
})();
