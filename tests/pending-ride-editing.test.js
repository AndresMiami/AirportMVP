// Pending ride editing — authenticated ownership, immutable identity and
// Edit-vs-Accept optimistic concurrency coverage, PR 3C-2C-B PR-1 edition:
// the endpoint now writes through migration 017's accept_quote_edit RPC.
// The mock SIMULATES the RPC's installed contract (ownership, pending+
// unassigned gate, details_version CAS, optional preservation, booker
// coherence, frozen commission ratio) so every behavioral check pins the
// endpoint↔RPC integration; the REAL RPC is exercised by the PGlite
// behavioral harness before merge.
//
// Run: node tests/pending-ride-editing.test.js

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.ADMIN_TELEGRAM_CHAT_ID;
// PR-1 dark contract: the no-token path must never need signing config.
delete process.env.QUOTE_SIGNING_CURRENT_ID;
delete process.env.QUOTE_SIGNING_CURRENT_SECRET;
delete process.env.QUOTE_SIGNING_PREVIOUS_ID;
delete process.env.QUOTE_SIGNING_PREVIOUS_SECRET;

const BID = '123e4567-e89b-42d3-a456-426614174000';
const OP_ID = '9f8e7d6c-5b4a-4321-8abc-def012345678';

let customer = { id: 'cust-a' };
let customerError = null;
let booking = null;
let bookingReadError = null;
let rereadError = null;    // fails reads AFTER the first (conflict/confirm)
let rereadMissing = false; // later reads find no booking
let bookingSelects = 0;
let rpcError = null;
let rpcForcedResult = null; // inject an arbitrary outcome
let capturedRpc = null;

function resetBooking(overrides = {}) {
  booking = {
    id: BID,
    trip_id: 'LM-EDIT',
    status: 'pending',
    assigned_driver: null,
    customer_id: 'cust-a',
    details_version: 1,
    price: 100,
    payment_status: 'unpaid',
    payment_method: 'zelle',
    host_commission: 6,
    created_at: '2026-08-01T12:00:00Z',
    referred_by_host: 'host-a',
    source: 'website',
    customer_email: 'stored@example.com',
    flight_number: 'AA100',
    notes: 'stored note',
    pickup_sign: 'STORED',
    promo_code: 'PROMO',
    booker_name: null,
    booker_phone: null,
    pickup_location: 'Old pickup',
    dropoff_location: 'Old dropoff',
    pickup_datetime: '2026-09-01T15:00:00Z',
    passengers: 2,
    bags: 1,
    vehicle_type: 'sedan',
    vehicle_name: 'Tesla Model Y',
    duration_minutes: 30,
    customer_name: 'Pat Passenger',
    customer_phone: '+1 305 555 0100',
    ...overrides
  };
  customer = { id: 'cust-a' };
  customerError = null;
  bookingReadError = null;
  rereadError = null;
  rereadMissing = false;
  bookingSelects = 0;
  rpcError = null;
  rpcForcedResult = null;
  capturedRpc = null;
}

// Faithful simulation of accept_quote_edit's installed no_token contract.
function simulateEditRpc(a) {
  if (!booking || booking.id !== a.p_booking_id ||
      booking.customer_id !== a.p_customer_id) {
    return { outcome: 'not_found' };
  }
  if (booking.status !== 'pending' || booking.assigned_driver) {
    return { outcome: 'not_editable' };
  }
  if (booking.details_version !== a.p_expected_details_version) {
    return { outcome: 'version_conflict' };
  }
  const e = a.p_edit || {};
  // Frozen commission ratio from the STORED row (017 rule).
  const ratio = booking.price > 0 && booking.host_commission > 0
    ? booking.host_commission / booking.price : 0;
  const next = { ...booking };
  const replace = ['pickup_location', 'dropoff_location', 'pickup_datetime',
    'passengers', 'bags', 'vehicle_type', 'vehicle_name', 'booking_mode',
    'duration_minutes', 'customer_name', 'customer_phone'];
  for (const col of replace) {
    if (Object.prototype.hasOwnProperty.call(e, col)) next[col] = e[col];
  }
  // Mirrors migration 018 (R1): an edit is a new write, and the writer sets
  // duration_minutes NULL unconditionally — clearing legacy values too.
  next.duration_minutes = null;
  // Optional preservation: omitted/blank keys keep the stored value.
  for (const col of ['customer_email', 'flight_number', 'notes', 'pickup_sign', 'promo_code']) {
    if (Object.prototype.hasOwnProperty.call(e, col) && e[col]) next[col] = e[col];
  }
  // payment_method: preserved unless the key arrives (the endpoint must
  // never send it — pinned below).
  if (Object.prototype.hasOwnProperty.call(e, 'payment_method') && e.payment_method) {
    next.payment_method = e.payment_method;
  }
  // Booker coherence: key present + nonblank name -> set (self clears);
  // absent -> preserve; phone only ever beside a name.
  if (Object.prototype.hasOwnProperty.call(e, 'booker_name') && e.booker_name) {
    if (e.booker_name === next.customer_name) {
      next.booker_name = null;
      next.booker_phone = null;
    } else {
      next.booker_name = e.booker_name;
      next.booker_phone = e.booker_phone || null;
    }
  }
  next.price = a.p_client_price;
  next.host_commission = Math.round(a.p_client_price * ratio * 100) / 100;
  next.details_version = booking.details_version + 1;
  booking = next;
  return { outcome: 'updated', booking_id: booking.id, details_version: booking.details_version };
}

const dbClient = {
  rpc: async (name, args) => {
    assert.strictEqual(name, 'accept_quote_edit');
    capturedRpc = args;
    if (rpcError) return { data: null, error: rpcError };
    if (rpcForcedResult) return { data: rpcForcedResult, error: null };
    return { data: simulateEditRpc(args), error: null };
  },
  from(table) {
    if (table === 'customers') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: customer, error: customerError })
          })
        })
      };
    }
    if (table === 'operation_receipts' || table === 'quote_acceptances') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) })
        })
      };
    }
    if (table !== 'bookings') throw new Error('unexpected table ' + table);
    return {
      select(columns) {
        const filters = {};
        const chain = {
          eq(col, value) { filters[col] = value; return chain; },
          async maybeSingle() {
            bookingSelects++;
            if (bookingReadError) return { data: null, error: bookingReadError };
            if (bookingSelects > 1) {
              if (rereadError) return { data: null, error: rereadError };
              if (rereadMissing) return { data: null, error: null };
            }
            if (!booking || (filters.id && filters.id !== booking.id)) {
              return { data: null, error: null };
            }
            const selected = {};
            columns.split(',').map((x) => x.trim()).forEach((key) => {
              selected[key] = booking[key];
            });
            return { data: selected, error: null };
          }
        };
        return chain;
      },
      update() {
        throw new Error('direct bookings UPDATE is forbidden — the RPC is the only writer');
      }
    };
  }
};

const supabaseMock = {
  createClient: (url, key) => key === 'anon-key'
    ? {
        auth: {
          getUser: async (token) => {
            if (token === 'tok-a') return { data: { user: { id: 'auth-a' } }, error: null };
            if (token === 'tok-outage') return { data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'down' } };
            return { data: { user: null }, error: { status: 401, message: 'bad token' } };
          }
        }
      }
    : dbClient
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const fn = require(path.join(repoRoot, 'backend/functions/update-pending-booking.js'));

function mkEdit(overrides = {}) {
  return {
    bookingId: BID,
    expectedDetailsVersion: 1,
    customerName: 'Pat Passenger',
    phone: '+1 305 555 0100',
    pickup: 'New pickup',
    dropoff: 'New dropoff',
    dateTime: '2026-09-02T16:30:00Z',
    vehicle: 'Cadillac Escalade',
    price: 165,
    passengers: 4,
    bags: 3,
    mode: 'dropoff',
    durationMinutes: 42,
    paymentMethod: 'cash', // force-sent by the current browser — must be ignored
    ...overrides
  };
}
const post = (payload, token) => fn.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(payload)
});

let passed = 0;
function check(name, fn2) { fn2(); passed++; console.log('✓ ' + name); }

(async () => {
  resetBooking();
  let r = await post(mkEdit());
  check('missing token -> 401', () => assert.strictEqual(r.statusCode, 401));

  r = await post(mkEdit(), 'tok-bad');
  check('invalid token -> 401', () => assert.strictEqual(r.statusCode, 401));

  r = await post(mkEdit(), 'tok-outage');
  check('auth outage -> 500, never mislabeled as expired', () => assert.strictEqual(r.statusCode, 500));

  resetBooking(); customer = null;
  r = await post(mkEdit(), 'tok-a');
  check('missing customer profile -> 403', () => assert.strictEqual(r.statusCode, 403));

  resetBooking({ customer_id: 'cust-b' });
  r = await post(mkEdit(), 'tok-a');
  check('another customer cannot edit -> 403 (legacy pre-check)', () => assert.strictEqual(r.statusCode, 403));

  resetBooking({ status: 'confirmed', assigned_driver: 'drv-1' });
  r = await post(mkEdit(), 'tok-a');
  check('accepted ride cannot be edited -> 409', () => assert.strictEqual(r.statusCode, 409));

  resetBooking();
  r = await post(mkEdit({ expectedDetailsVersion: 0 }), 'tok-a');
  check('invalid version -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await post(mkEdit({ passengers: 0 }), 'tok-a');
  check('invalid ride details -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await post(mkEdit({ vehicle: 'Hovercraft' }), 'tok-a');
  check('unknown vehicle -> sanitized 400', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(JSON.parse(r.body).error, 'Invalid vehicle');
  });

  resetBooking();
  r = await post(mkEdit(), 'tok-a');
  check('pending edit updates the SAME booking identity and increments version', () => {
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.bookingId, BID);
    assert.strictEqual(body.tripId, 'LM-EDIT');
    assert.strictEqual(body.detailsVersion, 2);
    assert.strictEqual(booking.id, BID);
    assert.strictEqual(booking.details_version, 2);
  });

  check('route, schedule, vehicle, capacity and price change atomically', () => {
    assert.strictEqual(booking.pickup_location, 'New pickup');
    assert.strictEqual(booking.dropoff_location, 'New dropoff');
    assert.strictEqual(booking.pickup_datetime, new Date('2026-09-02T16:30:00Z').toISOString());
    assert.strictEqual(booking.vehicle_type, 'suv');
    assert.strictEqual(booking.vehicle_name, 'Cadillac Escalade');
    assert.strictEqual(booking.passengers, 4);
    assert.strictEqual(booking.bags, 3);
    assert.strictEqual(booking.price, 165);
    assert.ok(!('duration_minutes' in capturedRpc.p_edit),
      'R1: the endpoint must not forward duration');
    assert.strictEqual(booking.duration_minutes, null,
      'R1: the writer persists NULL duration on every edit');
  });

  check('immutable fields never appear in p_edit', () => {
    for (const col of ['id', 'trip_id', 'customer_id', 'created_at', 'referred_by_host',
      'source', 'status', 'assigned_driver', 'price', 'host_commission', 'details_version']) {
      assert.ok(!(col in capturedRpc.p_edit), col + ' must not be in p_edit');
    }
  });

  check('payment_method is NEVER sent — stored non-cash value survives the forced browser default', () => {
    assert.ok(!('payment_method' in capturedRpc.p_edit));
    assert.strictEqual(booking.payment_method, 'zelle');
  });

  check('same-person booker fields stay null and commission percentage is preserved', () => {
    assert.strictEqual(booking.booker_name, null);
    assert.strictEqual(booking.booker_phone, null);
    assert.strictEqual(booking.host_commission, Math.round(165 * 0.06 * 100) / 100);
  });

  check('RPC receives owner identity, CAS version and client price — no direct UPDATE exists', () => {
    assert.strictEqual(capturedRpc.p_booking_id, BID);
    assert.strictEqual(capturedRpc.p_customer_id, 'cust-a');
    assert.strictEqual(capturedRpc.p_auth_user_id, 'auth-a');
    assert.strictEqual(capturedRpc.p_expected_details_version, 1);
    assert.strictEqual(capturedRpc.p_client_price, 165);
    assert.strictEqual(capturedRpc.p_verdict, 'no_token');
    assert.strictEqual(capturedRpc.p_jti, null);
    assert.strictEqual(capturedRpc.p_token_digest, null);
  });

  resetBooking({ details_version: 5 });
  r = await post(mkEdit({ expectedDetailsVersion: 1 }), 'tok-a');
  check('concurrent/stale edit -> 409 and cannot overwrite the winner', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.currentDetailsVersion, 5);
    assert.strictEqual(booking.pickup_location, 'Old pickup');
  });

  resetBooking(); rpcError = { code: 'XX000' };
  r = await post(mkEdit(), 'tok-a');
  check('database failure -> 500 and original booking stays unchanged', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(booking.pickup_location, 'Old pickup');
    assert.ok(!JSON.stringify(r.body).includes('XX000'));
  });

  resetBooking();
  r = await post(mkEdit({ email: '', flightNumber: '', notes: '', pickupSign: '', promoCode: '' }), 'tok-a');
  check('restored-session edit with blank optionals preserves every stored value', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(booking.customer_email, 'stored@example.com');
    assert.strictEqual(booking.flight_number, 'AA100');
    assert.strictEqual(booking.notes, 'stored note');
    assert.strictEqual(booking.pickup_sign, 'STORED');
    assert.strictEqual(booking.promo_code, 'PROMO');
  });

  resetBooking();
  r = await post(mkEdit({ email: 'new@example.com', notes: 'new note' }), 'tok-a');
  check('non-empty submitted optionals replace stored values', () => {
    assert.strictEqual(booking.customer_email, 'new@example.com');
    assert.strictEqual(booking.notes, 'new note');
    assert.strictEqual(booking.flight_number, 'AA100');
  });

  resetBooking();
  r = await post(mkEdit({ bookerPhone: '+1 111 111 1111' }), 'tok-a');
  check('orphan bookerPhone with no stored booker -> both NULL, never an orphaned phone', () => {
    assert.strictEqual(booking.booker_name, null);
    assert.strictEqual(booking.booker_phone, null);
  });

  resetBooking({ booker_name: 'Bea Booker', booker_phone: '+1 222 222 2222' });
  r = await post(mkEdit({ bookerPhone: '+1 111 111 1111' }), 'tok-a');
  check('orphan bookerPhone with a stored pair -> pair preserved, orphan ignored', () => {
    assert.strictEqual(booking.booker_name, 'Bea Booker');
    assert.strictEqual(booking.booker_phone, '+1 222 222 2222');
  });

  // ---- PR-1 additions: envelope, outcome registry, dark-safety ----

  resetBooking({ status: 'confirmed', assigned_driver: 'drv-1' });
  r = await post(mkEdit({ operationId: OP_ID }), 'tok-a');
  check('operationId request skips the pre-check and gets the RPC verdict (not_editable)', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.ok(capturedRpc, 'RPC must be reached');
    assert.strictEqual(capturedRpc.p_operation_request_id, OP_ID);
    assert.ok(/^[0-9a-f]{64}$/.test(capturedRpc.p_request_digest));
    assert.strictEqual(JSON.parse(r.body).error, 'Ride is no longer editable');
  });

  resetBooking(); rpcForcedResult = { outcome: 'idempotent', booking_id: BID, details_version: 2 };
  r = await post(mkEdit({ operationId: OP_ID }), 'tok-a');
  check('idempotent outcome -> 200 with live row, marked idempotent', () => {
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.idempotent, true);
    assert.strictEqual(body.bookingId, BID);
  });

  for (const [outcome, status, errText] of [
    ['outdated_client', 428, 'outdated_client'],
    ['quote_required', 428, 'quote_required'],
    ['quote_expired', 409, 'quote_expired'],
    ['quote_not_yet_valid', 409, 'quote_expired'],
    ['quote_mismatch', 409, 'quote_invalid'],
    ['epoch_conflict', 409, 'quote_stale'],
    ['conflict', 409, null],
    ['refused', 409, null],
    ['blocked', 503, null]
  ]) {
    resetBooking(); rpcForcedResult = { outcome };
    r = await post(mkEdit({ operationId: OP_ID }), 'tok-a');
    check(`outcome ${outcome} -> ${status}${errText ? ' ' + errText : ''}`, () => {
      assert.strictEqual(r.statusCode, status);
      if (errText) assert.strictEqual(JSON.parse(r.body).error, errText);
    });
  }

  resetBooking(); rpcForcedResult = { outcome: 'quote_consumed', booking_id: BID };
  r = await post(mkEdit({ operationId: OP_ID }), 'tok-a');
  check('outcome quote_consumed -> 409 quote_stale + requote + live version', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.error, 'quote_stale');
    assert.strictEqual(body.requote, true);
    assert.strictEqual(body.currentDetailsVersion, 1);
  });

  resetBooking(); rpcForcedResult = { outcome: 'something_new' };
  r = await post(mkEdit({ operationId: OP_ID }), 'tok-a');
  check('unknown outcome fails closed as sanitized 500', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(JSON.parse(r.body).error, 'Could not process this request');
  });

  resetBooking();
  r = await post(mkEdit(), 'tok-a');
  check('no-token edit succeeds with every quote secret absent (lazy signing config)', () => {
    assert.strictEqual(r.statusCode, 200);
  });

  resetBooking();
  r = await post(mkEdit({ quoteToken: {} }), 'tok-a');
  check('present malformed edit token -> requote, never legacy/RPC traffic', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).error, 'quote_invalid');
    assert.strictEqual(JSON.parse(r.body).requote, true);
    assert.strictEqual(capturedRpc, null);
    assert.strictEqual(booking.pickup_location, 'Old pickup');
  });

  resetBooking();
  r = await post(mkEdit({ quoteToken: 'tok.abc', vehicleKey: 'escalade', airportCode: 'MIA', placeId: 'ChIJvalidplace1234567', routeMilesTenths: 120, routeMinutes: 25 }), 'tok-a');
  check('presented token with signing config unavailable + no receipt match -> sanitized 500, RPC never called', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
    assert.strictEqual(booking.pickup_location, 'Old pickup');
  });

  resetBooking({ duration_minutes: 30 });
  process.env.QUOTE_SIGNING_CURRENT_ID = 'k1';
  process.env.QUOTE_SIGNING_CURRENT_SECRET = 'edit-test-secret-0123456789abcdef0123456789abcd';
  try {
    r = await post(mkEdit({
      durationMinutes: undefined,
      pickup: 'Quoted new pickup',
      dropoff: 'Quoted new dropoff',
      quoteToken: 'garbage.token',
      vehicleKey: 'escalade',
      airportCode: 'MIA',
      placeId: 'ChIJvalidplace1234567',
      routeMilesTenths: 120,
      routeMinutes: 25
    }), 'tok-a');
  } finally {
    delete process.env.QUOTE_SIGNING_CURRENT_ID;
    delete process.env.QUOTE_SIGNING_CURRENT_SECRET;
  }
  check('R1: a bad-signature modern edit forwards NO duration and CLEARS the stale legacy value', () => {
    // Inverted from the pre-R1 pin (which stored echoed routeMinutes): the
    // edit writer now sets duration_minutes NULL unconditionally, so the
    // legacy 30 on the stored row is actively cleared by this edit.
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedRpc.p_verdict, 'verify_failed');
    assert.ok(/^[0-9a-f]{64}$/.test(capturedRpc.p_token_digest));
    assert.strictEqual(capturedRpc.p_payload, null);
    assert.ok(!('duration_minutes' in capturedRpc.p_edit),
      'p_edit must not carry duration_minutes at all');
    assert.strictEqual(booking.duration_minutes, null);
    assert.strictEqual(booking.pickup_location, 'Quoted new pickup');
  });

  resetBooking();
  r = await post(mkEdit({ quoteToken: 'tok.abc', vehicleKey: 'hoverboard', airportCode: 'MIA', placeId: 'ChIJvalidplace1234567', routeMilesTenths: 120, routeMinutes: 25 }), 'tok-a');
  check('malformed modern quote contract -> 409 requote, never a legacy fallback', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.error, 'quote_invalid');
    assert.strictEqual(body.requote, true);
    assert.strictEqual(capturedRpc, null);
  });

  resetBooking();
  r = await post(mkEdit({ quoteToken: 'tok.abc', vehicleKey: 'tesla', airportCode: 'MIA', placeId: 'ChIJvalidplace1234567', routeMilesTenths: 120, routeMinutes: 0 }), 'tok-a');
  check('routeMinutes 0 refused at the endpoint (1..1440 contract) -> requote', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).requote, true);
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
