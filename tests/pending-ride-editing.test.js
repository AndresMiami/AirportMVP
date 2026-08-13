// Pending ride editing — authenticated ownership, immutable identity and
// Edit-vs-Accept optimistic concurrency coverage.
//
// Run: node tests/pending-ride-editing.test.js

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.ADMIN_TELEGRAM_CHAT_ID;

const BID = '123e4567-e89b-42d3-a456-426614174000';
const IMMUTABLE = ['id', 'trip_id', 'customer_id', 'created_at', 'referred_by_host',
  'source', 'status', 'assigned_driver'];

let customer = { id: 'cust-a' };
let customerError = null;
let booking = null;
let bookingReadError = null;
let rereadError = null;   // fails ONLY the second (conflict) read
let rereadMissing = false; // second read finds no booking
let bookingSelects = 0;
let updateError = null;
let capturedUpdate = null;
let capturedFilters = null;

function resetBooking(overrides = {}) {
  booking = {
    id: BID,
    trip_id: 'LM-EDIT',
    status: 'pending',
    assigned_driver: null,
    customer_id: 'cust-a',
    details_version: 1,
    price: 100,
    host_commission: 6,
    created_at: '2026-08-01T12:00:00Z',
    referred_by_host: 'host-a',
    source: 'website',
    ...overrides
  };
  customer = { id: 'cust-a' };
  customerError = null;
  bookingReadError = null;
  rereadError = null;
  rereadMissing = false;
  bookingSelects = 0;
  updateError = null;
  capturedUpdate = null;
  capturedFilters = null;
}

function applyUpdate(payload, filters) {
  if (!booking ||
      booking.id !== filters.id ||
      booking.customer_id !== filters.customer_id ||
      booking.status !== filters.status ||
      booking.details_version !== filters.details_version ||
      booking.assigned_driver !== filters.assigned_driver) return null;
  booking = { ...booking, ...payload };
  return { ...booking };
}

const dbClient = {
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
      update(payload) {
        capturedUpdate = payload;
        const filters = {};
        capturedFilters = filters;
        const chain = {
          eq(col, value) { filters[col] = value; return chain; },
          is(col, value) { filters[col] = value; return chain; },
          select() { return chain; },
          async maybeSingle() {
            if (updateError) return { data: null, error: updateError };
            return { data: applyUpdate(payload, filters), error: null };
          }
        };
        return chain;
      }
    };
  }
};

const authClient = {
  auth: {
    getUser: async (token) => token === 'good'
      ? { data: { user: { id: 'auth-a' } }, error: null }
      : token === 'outage'
        ? { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } }
        : { data: { user: null }, error: { status: 401 } }
  }
};

const supabaseMock = {
  createClient: (_url, key) => key === 'service-key' ? dbClient : authClient
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = {
  id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock
};
const editFn = require(path.join(repoRoot, 'backend/functions/update-pending-booking.js'));

const validBody = (overrides = {}) => ({
  bookingId: BID,
  expectedDetailsVersion: 1,
  customerName: 'Maria Passenger',
  phone: '+17865550101',
  bookerName: 'Maria Passenger',
  bookerPhone: '+17865550101',
  email: 'maria@example.com',
  pickup: '100 New Pickup Ave, Miami, FL',
  dropoff: 'Miami International Airport',
  dateTime: '2026-08-20T18:00:00-04:00',
  vehicle: 'Tesla Model Y',
  price: 120,
  mode: 'dropoff',
  passengers: 2,
  bags: 3,
  paymentMethod: 'cash',
  notes: 'Lobby',
  pickupSign: 'MARIA',
  promoCode: 'TEST',
  flightNumber: 'AA123',
  durationMinutes: 42,
  ...overrides
});

const post = (body = validBody(), token = 'good') => editFn.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  body: JSON.stringify(body)
});

const get = (id = BID, token = 'good') => editFn.handler({
  httpMethod: 'GET',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  queryStringParameters: { id }
});

// Full-bodied row for snapshot tests: editable fields PLUS private and
// operational internals the whitelist must never leak.
const snapshotRow = () => ({
  booking_mode: 'dropoff',
  pickup_location: '100 Stored Pickup Ave, Miami, FL',
  dropoff_location: 'Miami International',
  pickup_datetime: '2026-08-20T18:00:00+00:00',
  customer_name: 'Maria Traveler',
  customer_phone: '+17865550101',
  customer_email: 'maria@example.com',
  booker_name: 'Booker Bob',
  booker_phone: '+17865550999',
  passengers: 2,
  bags: 3,
  vehicle_type: 'sedan',
  vehicle_name: 'Tesla Model Y',
  flight_number: 'AA123',
  pickup_sign: 'MARIA',
  notes: 'Lobby',
  promo_code: 'KEEP10',
  driver_payout: 90,
  linkmia_commission: 30,
  cancelled_at: null,
  cancel_fee_percent: null,
  payment_status: 'unpaid'
});

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

(async () => {
  resetBooking();
  let r = await post(validBody(), null);
  check('missing token -> 401', () => assert.strictEqual(r.statusCode, 401));

  r = await post(validBody(), 'bad');
  check('invalid token -> 401', () => assert.strictEqual(r.statusCode, 401));

  r = await post(validBody(), 'outage');
  check('auth outage -> 500, never mislabeled as expired', () => assert.strictEqual(r.statusCode, 500));

  customer = null;
  r = await post();
  check('missing customer profile -> 403', () => assert.strictEqual(r.statusCode, 403));

  resetBooking({ customer_id: 'cust-other' });
  r = await post();
  check('another customer cannot edit -> 403', () => assert.strictEqual(r.statusCode, 403));

  resetBooking({ status: 'confirmed', assigned_driver: 'drv-a' });
  r = await post();
  check('accepted ride cannot be edited -> 409', () => assert.strictEqual(r.statusCode, 409));

  resetBooking();
  r = await post(validBody({ expectedDetailsVersion: 0 }));
  check('invalid version -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await post(validBody({ price: 0 }));
  check('invalid ride details -> 400', () => assert.strictEqual(r.statusCode, 400));

  resetBooking();
  r = await post();
  const success = JSON.parse(r.body);
  check('pending edit updates the SAME booking identity and increments version', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store');
    assert.strictEqual(success.bookingId, BID);
    assert.strictEqual(success.tripId, 'LM-EDIT');
    assert.strictEqual(success.detailsVersion, 2);
    assert.strictEqual(booking.id, BID);
    assert.strictEqual(booking.trip_id, 'LM-EDIT');
    assert.strictEqual(booking.customer_id, 'cust-a');
    assert.strictEqual(booking.created_at, '2026-08-01T12:00:00Z');
    assert.strictEqual(booking.referred_by_host, 'host-a');
  });
  check('route, schedule, vehicle, capacity and price change atomically', () => {
    assert.strictEqual(booking.pickup_location, '100 New Pickup Ave, Miami, FL');
    assert.strictEqual(booking.dropoff_location, 'Miami International Airport');
    assert.strictEqual(booking.vehicle_type, 'sedan');
    assert.strictEqual(booking.vehicle_name, 'Tesla Model Y');
    assert.strictEqual(booking.passengers, 2);
    assert.strictEqual(booking.bags, 3);
    assert.strictEqual(booking.price, 120);
    assert.strictEqual(booking.duration_minutes, 42);
  });
  check('immutable fields are absent from the UPDATE payload', () => {
    IMMUTABLE.forEach((key) => assert.ok(!(key in capturedUpdate), key + ' must stay immutable'));
  });
  check('same-person booker fields stay null and commission percentage is preserved', () => {
    assert.strictEqual(capturedUpdate.booker_name, null);
    assert.strictEqual(capturedUpdate.booker_phone, null);
    assert.strictEqual(capturedUpdate.host_commission, 7.2);
  });
  check('guarded UPDATE matches owner, pending status, unassigned driver and expected version', () => {
    assert.deepStrictEqual(capturedFilters, {
      id: BID,
      customer_id: 'cust-a',
      status: 'pending',
      details_version: 1,
      assigned_driver: null
    });
  });

  // The first edit already advanced the row to v2. Reusing the stale v1
  // form must match zero rows and leave the committed edit untouched.
  const beforeStale = { ...booking };
  r = await post(validBody({ pickup: 'Stale overwrite attempt' }));
  check('concurrent/stale edit -> 409 and cannot overwrite the winner', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).currentDetailsVersion, 2);
    assert.deepStrictEqual(booking, beforeStale);
  });

  resetBooking();
  updateError = { code: 'DB_EDIT' };
  const beforeFailure = { ...booking };
  r = await post();
  check('database failure -> 500 and original booking stays unchanged', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.deepStrictEqual(booking, beforeFailure);
  });

  // ---- Review fixes: optional-field preservation + booker coherence ----
  resetBooking({
    customer_email: 'stored@example.com', flight_number: 'DL999',
    notes: 'Gate note', pickup_sign: 'STORED', promo_code: 'KEEP10',
    booker_name: 'Booker Bob', booker_phone: '+17865550999'
  });
  r = await post(validBody({
    email: '', flightNumber: '', notes: '', pickupSign: '', promoCode: '',
    bookerName: '', bookerPhone: ''
  }));
  check('restored-session edit with blank optionals preserves every stored value', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpdate.customer_email, 'stored@example.com');
    assert.strictEqual(capturedUpdate.flight_number, 'DL999');
    assert.strictEqual(capturedUpdate.notes, 'Gate note');
    assert.strictEqual(capturedUpdate.pickup_sign, 'STORED');
    assert.strictEqual(capturedUpdate.promo_code, 'KEEP10');
    assert.strictEqual(capturedUpdate.booker_name, 'Booker Bob');
    assert.strictEqual(capturedUpdate.booker_phone, '+17865550999');
  });

  resetBooking({ customer_email: 'old@example.com', notes: 'old note' });
  r = await post(validBody({
    email: 'new@example.com', notes: 'new note',
    bookerName: 'Someone Else', bookerPhone: '+17865550111'
  }));
  check('non-empty submitted optionals replace stored values', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpdate.customer_email, 'new@example.com');
    assert.strictEqual(capturedUpdate.notes, 'new note');
    assert.strictEqual(capturedUpdate.booker_name, 'Someone Else');
    assert.strictEqual(capturedUpdate.booker_phone, '+17865550111');
  });

  resetBooking(); // no stored booker pair
  r = await post(validBody({ bookerName: '', bookerPhone: '+17865550222' }));
  check('orphan bookerPhone with no stored booker -> both NULL, never an orphaned phone', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpdate.booker_name, null);
    assert.strictEqual(capturedUpdate.booker_phone, null);
  });

  resetBooking({ booker_name: 'Booker Bob', booker_phone: '+17865550999' });
  r = await post(validBody({ bookerName: '', bookerPhone: '+17865550333' }));
  check('orphan bookerPhone with a stored pair -> pair preserved, orphan ignored', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpdate.booker_name, 'Booker Bob');
    assert.strictEqual(capturedUpdate.booker_phone, '+17865550999');
  });

  resetBooking({ booker_name: 'Booker Bob', booker_phone: '+17865550999' });
  r = await post(validBody({ bookerName: 'Maria Passenger', bookerPhone: '+17865550444' }));
  check('booker name matching the passenger clears the pair (explicit for-myself)', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpdate.booker_name, null);
    assert.strictEqual(capturedUpdate.booker_phone, null);
  });

  // ---- Conflict re-read honesty (Codex re-review, cancellation parity) ----
  resetBooking({ details_version: 2 }); // guarded update (expects v1) loses
  r = await post();
  check('conflict re-read with live row -> 409 real status + version, never unknown', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.currentStatus, 'pending');
    assert.strictEqual(body.currentDetailsVersion, 2);
    assert.ok(!r.body.includes('unknown'));
  });

  resetBooking({ details_version: 2 });
  rereadMissing = true;
  r = await post();
  check('booking vanished on conflict re-read -> 404, never 409 unknown', () => {
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(JSON.parse(r.body).error, 'Booking not found');
  });

  resetBooking({ details_version: 2 });
  rereadError = { code: 'DB_REREAD' };
  r = await post();
  check('conflict re-read database failure -> honest 500 Lookup failed, never a fake race', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(JSON.parse(r.body).error, 'Lookup failed');
  });

  // ---- Telegram doorbell stays informational ----
  resetBooking();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.ADMIN_TELEGRAM_CHAT_ID = 'test-chat';
  const realFetch = global.fetch;
  let doorbellCalls = 0;
  global.fetch = async () => { doorbellCalls++; return { ok: false, status: 400 }; };
  r = await post();
  global.fetch = realFetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ADMIN_TELEGRAM_CHAT_ID;
  check('Telegram non-2xx is warned about, never a passenger-visible failure', () => {
    assert.strictEqual(doorbellCalls, 1, 'doorbell was attempted');
    assert.strictEqual(r.statusCode, 200, 'the committed edit stays success');
    assert.strictEqual(JSON.parse(r.body).success, true);
  });

  // ---- GET snapshot: auth, ownership, status, whitelist ----
  resetBooking(snapshotRow());
  r = await get(BID, null);
  check('GET without token -> 401', () => assert.strictEqual(r.statusCode, 401));
  r = await get(BID, 'bad');
  check('GET invalid token -> 401', () => assert.strictEqual(r.statusCode, 401));
  r = await get(BID, 'outage');
  check('GET auth outage -> 500', () => assert.strictEqual(r.statusCode, 500));

  customer = null;
  r = await get();
  check('GET without customer profile -> 403', () => assert.strictEqual(r.statusCode, 403));

  resetBooking({ ...snapshotRow(), customer_id: 'cust-other' });
  r = await get();
  check('GET another customer\'s ride -> 403', () => assert.strictEqual(r.statusCode, 403));

  resetBooking(snapshotRow());
  booking = null;
  r = await get();
  check('GET missing booking -> 404', () => assert.strictEqual(r.statusCode, 404));

  resetBooking({ ...snapshotRow(), status: 'confirmed', assigned_driver: 'drv-a' });
  r = await get();
  check('GET accepted ride -> 409 with current status (not editable)', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).currentStatus, 'confirmed');
  });

  resetBooking(snapshotRow());
  r = await get();
  check('GET snapshot: traveler + booker identity, fresh version, no-store', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store');
    const snap = JSON.parse(r.body).snapshot;
    assert.strictEqual(snap.id, BID);
    assert.strictEqual(snap.trip_id, 'LM-EDIT');
    assert.strictEqual(snap.details_version, 1);
    assert.strictEqual(snap.customer_name, 'Maria Traveler');
    assert.strictEqual(snap.customer_phone, '+17865550101');
    assert.strictEqual(snap.booker_name, 'Booker Bob');
    assert.strictEqual(snap.booker_phone, '+17865550999');
    assert.strictEqual(snap.booking_mode, 'dropoff');
    assert.strictEqual(snap.vehicle_type, 'sedan');
    assert.strictEqual(snap.passengers, 2);
    assert.strictEqual(snap.notes, 'Lobby');
    assert.strictEqual(snap.pickup_sign, 'MARIA');
    assert.strictEqual(snap.flight_number, 'AA123');
    assert.strictEqual(snap.promo_code, 'KEEP10');
  });
  check('GET snapshot whitelist: no price, bags, commissions, audit, or internals', () => {
    const snap = JSON.parse(r.body).snapshot;
    for (const banned of ['price', 'bags', 'host_commission', 'driver_payout',
      'linkmia_commission', 'customer_id', 'status', 'assigned_driver',
      'created_at', 'referred_by_host', 'cancelled_at', 'cancel_fee_percent',
      'payment_status', 'source']) {
      assert.ok(!(banned in snap), banned + ' must not be in the snapshot');
    }
  });

  // ---- Explicit clearing ----
  for (const [field, blankBody] of [
    ['customer_email', { email: '' }],
    ['flight_number', { flightNumber: '' }],
    ['notes', { notes: '' }],
    ['pickup_sign', { pickupSign: '' }],
    ['promo_code', { promoCode: '' }]
  ]) {
    resetBooking(snapshotRow());
    r = await post(validBody({ ...blankBody, clearOptionalFields: [field] }));
    check(`deliberate clear of ${field} -> NULL stored`, () => {
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(capturedUpdate[field], null, field + ' must be cleared');
    });
  }

  resetBooking(snapshotRow());
  r = await post(validBody({ notes: 'kept because no clear signal', pickupSign: '', clearOptionalFields: ['pickup_sign'] }));
  check('clear touches ONLY listed fields; others replace/preserve normally', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpdate.pickup_sign, null);
    assert.strictEqual(capturedUpdate.notes, 'kept because no clear signal');
    assert.strictEqual(capturedUpdate.customer_email, 'maria@example.com');
  });

  resetBooking(snapshotRow());
  r = await post(validBody({ clearOptionalFields: ['assigned_driver'] }));
  check('unknown clear field -> 400, nothing written', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(capturedUpdate, null);
  });

  resetBooking(snapshotRow());
  r = await post(validBody({ notes: 'still here', clearOptionalFields: ['notes'] }));
  check('contradictory clear (listed while nonempty) -> 400, nothing written', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(capturedUpdate, null);
  });

  resetBooking(snapshotRow());
  r = await post(validBody({ clearOptionalFields: 'notes' }));
  check('non-array clearOptionalFields -> 400', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(capturedUpdate, null);
  });

  check('RESPONSE_FIELDS never exposes private personal fields', () => {
    const src = require('fs').readFileSync(
      path.join(repoRoot, 'backend/functions/update-pending-booking.js'), 'utf8');
    const line = src.match(/const RESPONSE_FIELDS = '([^']+)'/)[1];
    ['customer_email', 'booker_name', 'booker_phone', 'notes', 'pickup_sign', 'promo_code']
      .forEach((f) => assert.ok(!line.includes(f), f + ' must stay private'));
  });

  console.log('\nALL ' + passed + ' CHECKS PASS');
})().catch((error) => {
  console.error('\nFAIL:', error.stack || error.message);
  process.exit(1);
});
