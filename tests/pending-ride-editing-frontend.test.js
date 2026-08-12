// Pending edit frontend wiring — verifies that Edit ride reuses the booking
// form, preserves identity, and never returns to cancel-and-recreate.
//
// Run: node tests/pending-ride-editing-frontend.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const trip = read('trip.html');
const booking = read('indexMVP.html');
const driver = read('driver.html');
const sw = read('service-worker.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

check('pending action is labeled Edit ride, not Go back', () => {
  assert.ok(trip.includes('id="backBtn">✏️ Edit ride</button>'));
  assert.ok(!trip.includes('id="backBtn">← Go back</button>'));
});

check('Edit ride is exposed only while status is pending', () => {
  assert.ok(trip.includes("const isPending = b.status === 'pending'"));
  assert.ok(trip.includes("$('backBtn').classList.toggle('hidden', !isPending)"));
});

check('embedded and standalone trip pages carry booking id + version into edit mode', () => {
  assert.ok(trip.includes("type: 'lm-edit'"));
  assert.ok(trip.includes("sessionStorage.setItem('lm_pending_edit_intent'"));
  assert.ok(trip.includes("detailsVersion: Number(lastBooking?.details_version) || 1"));
});

check('booking form clearly enters guarded edit mode', () => {
  assert.ok(booking.includes('beginPendingEdit({ bookingId, tripCode, detailsVersion })'));
  assert.ok(booking.includes('Your existing ride stays active until these changes are saved.'));
  assert.ok(booking.includes('<span class="btn-main-text">Save changes</span>'));
});

check('edit preserves trip identity and calls only the in-place endpoint', () => {
  assert.ok(booking.includes("? (editContext.tripCode || currentActiveBooking?.trip_id || '')"));
  assert.ok(booking.includes('apiPayload.bookingId = editContext.bookingId'));
  assert.ok(booking.includes('apiPayload.expectedDetailsVersion = editContext.detailsVersion'));
  assert.ok(booking.includes("? '/api/update-pending-booking'"));
  assert.ok(!booking.includes("const cancelResponse = await fetch('/api/booking-status'"));
});

check('an edit never writes provisional local success before the server commits', () => {
  const guardedWrite = booking.indexOf('if (!isEditing) {\n                        localStorage.setItem(`trip_${tripId}`');
  const request = booking.indexOf("? '/api/update-pending-booking'");
  assert.ok(guardedWrite >= 0 && request > guardedWrite);
});

check('conflict and failure preserve server truth instead of pretending success', () => {
  assert.ok(booking.includes('This ride changed while you were editing. Your changes were not applied.'));
  assert.ok(booking.includes('Changes not saved. Your original ride is unchanged.'));
  assert.ok(booking.includes("isEditing ? 'Changes not saved' : 'Booking not submitted'"));
});

check('time changes recalculate route-aware vehicle pricing before save', () => {
  const updateDateTime = booking.indexOf('updateDateTime() {');
  const nextMethod = booking.indexOf('\n            showTimeWarning()', updateDateTime);
  const block = booking.slice(updateDateTime, nextMethod);
  assert.ok(block.includes('this.updateVehiclePrices()'));
});

check('driver Accept sends the exact details version it rendered', () => {
  assert.ok(driver.includes("if (action === 'accept')"));
  assert.ok(driver.includes('body.expectedDetailsVersion = Number(offer?.details_version) || 1'));
});

check('service worker evicts pre-edit booking-form clients (v1.3.18+)', () => {
  const m = sw.match(/CACHE_NAME = 'linkmia-v(\d+)\.(\d+)\.(\d+)'/);
  assert.ok(m, 'CACHE_NAME missing');
  const [maj, min, pat] = m.slice(1).map(Number);
  assert.ok(maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 18))),
    `cache ${m[0]} must be >= 1.3.18 (1.3.17 shipped with cancellation)`);
});

console.log('\nALL ' + passed + ' CHECKS PASS');
