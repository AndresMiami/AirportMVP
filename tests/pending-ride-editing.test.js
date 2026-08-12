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
            if (bookingReadError) return { data: null, error: bookingReadError };
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
