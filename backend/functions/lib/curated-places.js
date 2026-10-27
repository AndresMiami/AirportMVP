// Curated cruise terminals — the SERVER side.
//
// Loads the same validator (js/curated-places.js) and the same data
// (data/curated-places.json) the browser uses; both are static requires, so
// esbuild inlines them into every function bundle at deploy time and no
// runtime file read (and no `included_files` entry) is involved. The server
// copy is the one that decides STORED labels: a booking receives a terminal
// label only when its quote token verified and the canonical place ID is a
// VERIFIED terminal here — client text is never upgraded (plan v7 §4).
//
// An invalid registry is logged once and disables curated labels; bookings
// then behave exactly as before this file existed.

'use strict';

const core = require('../../../js/curated-places.js');
const RAW_REGISTRY = require('../../../data/curated-places.json');

const validation = core.validateRegistry(RAW_REGISTRY);
if (!validation.ok) {
  console.error('curated-places registry invalid — curated labels disabled:', validation.errors.join('; '));
}

// booking_mode 'pickup' = the passenger is collected AT the airport, so the
// curated place is the destination; 'dropoff' = the ride goes TO the airport,
// so the curated place is the origin (quote-ride.js routes
// `mode === 'dropoff' ? place : airport` as the origin).
const ADDRESS_COLUMN = Object.freeze({
  pickup: 'dropoff_location',
  dropoff: 'pickup_location'
});

function registry() {
  return validation.ok ? validation.registry : null;
}

function findVerifiedTerminal(placeId) {
  return core.findVerifiedByPlaceId(registry(), placeId);
}

// { column, label, terminalId } when the canonical place ID is a verified
// terminal and the booking mode names an address side; otherwise null.
function projectCuratedLabel(canonicalPlaceId, bookingMode) {
  const column = Object.prototype.hasOwnProperty.call(ADDRESS_COLUMN, bookingMode) ? ADDRESS_COLUMN[bookingMode] : null;
  if (!column) return null;
  const terminal = findVerifiedTerminal(canonicalPlaceId);
  if (!terminal) return null;
  return { column, label: core.terminalLabel(terminal), terminalId: terminal.id };
}

module.exports = {
  ADDRESS_COLUMN,
  registry,
  findVerifiedTerminal,
  projectCuratedLabel,
  validation: Object.freeze({ ok: validation.ok, errors: validation.errors.slice() })
};
