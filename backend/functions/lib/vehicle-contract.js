// Vehicle PERSISTENCE contract (PR-A, plan v8.6 §3A item 7).
//
// This is the single canonical statement of the vehicle metadata that must
// agree across the endpoints, the installed SQL writers, the rate card and
// the browser copies. It is PROMOTED from the table that already existed as
// tests/vehicle-metadata-drift.test.js's EXPECTED literal (the P0 drift
// guard, PR #85) — deliberately MOVED rather than copied, so the repository
// does not gain a tenth hand-maintained catalog. The drift suite now imports
// this module and keeps pinning every other copy against it.
//
// WHAT THIS IS NOT:
//   * not a pricing authority — the rate card prices rides, and its
//     validator deliberately accepts a much wider shape (capacities to 1000,
//     any nonblank name: ride-rate-card.js:201-217). This module is what a
//     resolved card must AGREE WITH before a hydration DTO may leave the
//     endpoint;
//   * not a dashboard-configurable catalog. When operator-configurable fleet
//     metadata arrives, the endpoint and the installed writer contract have
//     to move TOGETHER; a card edit alone must not be able to change what a
//     booking persists. That is an honest temporary boundary, recorded here
//     rather than implied away.
//
// A genuine business change (a new vehicle, a different capacity, a rename)
// edits THIS table consciously, and the drift suite then reports every copy
// still carrying the old values.
//
// ORDER MATTERS: VEHICLE_KEYS is also the canonical vehicle sequence the
// carousel array and its markup must share.

// Independent of the table above: the bounds the writer paths enforce
// (update-pending-booking.js parseEdit, and the accept_quote_create/edit band
// check — pinned by the drift suite against the target writer source and the
// live 018; which migration is installed is the migration record's business,
// not this table's). A card may satisfy every per-vehicle equality above and
// still expose a capacity no write could carry, so both checks are required.
const WRITER_CEILINGS = Object.freeze({ passengers: 12, bags: 15 });

const VEHICLE_CONTRACT = Object.freeze({
  tesla: Object.freeze({ name: 'Tesla Model Y', category: 'sedan', passengers: 4, bags: 4 }),
  escalade: Object.freeze({ name: 'Cadillac Escalade', category: 'suv', passengers: 7, bags: 8 }),
  sprinter: Object.freeze({ name: 'Mercedes Sprinter', category: 'sprinter', passengers: 12, bags: 15 })
});

const VEHICLE_KEYS = Object.freeze(['tesla', 'escalade', 'sprinter']);

// Category-keyed capacity, DERIVED from the single table above plus ONE
// explicit legacy alias — never restated. Repeating the labels and capacities
// here would recreate exactly the second authority this module exists to
// remove. The alias is the 'escalade' CATEGORY old booking rows still carry
// (present in trip.html and create-booking's CAPACITY): READING such a row is
// fine, WRITING one back is not, which is why storedPairToKey refuses it.
const LEGACY_CATEGORY_ALIASES = Object.freeze({ escalade: 'escalade' });

const CATEGORY_CONTRACT = Object.freeze(
  VEHICLE_KEYS.reduce((acc, key) => {
    const v = VEHICLE_CONTRACT[key];
    acc[v.category] = Object.freeze({
      label: v.name, passengers: v.passengers, bags: v.bags
    });
    return acc;
  }, Object.keys(LEGACY_CATEGORY_ALIASES).reduce((acc, alias) => {
    const v = VEHICLE_CONTRACT[LEGACY_CATEGORY_ALIASES[alias]];
    acc[alias] = Object.freeze({
      label: v.name, passengers: v.passengers, bags: v.bags
    });
    return acc;
  }, {}))
);

// OWN-property lookup everywhere. A plain `VEHICLE_CONTRACT[key]` would
// answer for 'constructor', '__proto__' and 'toString'; the rule is
// own-property, not a blocklist of the three names people remember.
function ownVehicle(key) {
  if (typeof key !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(VEHICLE_CONTRACT, key)
    ? VEHICLE_CONTRACT[key]
    : null;
}

function ownCategory(category) {
  if (typeof category !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CATEGORY_CONTRACT, category)
    ? CATEGORY_CONTRACT[category]
    : null;
}

// ROUND-TRIP CLOSURE (plan §3A items 6-7): the ONLY stored pairs a hydrated
// edit may carry back out unchanged are the three exact canonical pairs the
// installed verified writer persists. Legacy aliases — including the stored
// vehicle_type 'escalade' and names like 'Black Escalade' that the POST's
// VEHICLE_TYPE map still accepts — resolve to NO key here on purpose: an
// unrelated edit must never silently canonicalize a row the passenger did
// not ask to change. Such rows fail closed and enter the pre-PR-B inventory.
function storedPairToKey(vehicleType, vehicleName) {
  if (typeof vehicleType !== 'string' || typeof vehicleName !== 'string') return null;
  for (const key of VEHICLE_KEYS) {
    const v = VEHICLE_CONTRACT[key];
    if (v.category === vehicleType && v.name === vehicleName) return key;
  }
  return null;
}

module.exports = {
  VEHICLE_CONTRACT,
  LEGACY_CATEGORY_ALIASES,
  VEHICLE_KEYS,
  CATEGORY_CONTRACT,
  WRITER_CEILINGS,
  ownVehicle,
  ownCategory,
  storedPairToKey
};
