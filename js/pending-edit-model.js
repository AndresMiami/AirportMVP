// Pending-edit MODEL (PR-A, plan v8.6 3B) - pure, and deliberately dark.
//
// No page loads this file and it is NOT in the service worker's
// STATIC_CACHE_URLS, so PR-A ships it with zero passenger-visible effect and
// no cache turnover. PR-B wires it. Nothing here touches the DOM, the
// network, or global state; the one controller at the bottom takes explicit
// element references and is exercised only by tests until PR-B.
//
// THE THREE LAYERS, kept distinct:
//   SNAPSHOT - the immutable hydration DTO for this editing session.
//   DRAFT    - an independently deep-cloned mutable copy the card edits.
//   QUOTE    - the held signed price (owned by the page, not by this module).
//
// Isolation is enforced, not assumed: the snapshot is deep-frozen and the
// draft is a structural clone, so no nested mutation of either can reach the
// other.
//
// SERIALIZATION NOTE: identity keys are JSON over ordered structures, never
// a delimiter join. A single-character delimiter is collidable the moment a
// field can contain it, and a NUL delimiter additionally makes this source
// file binary to Git and to `file`. Both were real defects here; JSON fixes
// the class rather than the instance.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PendingEditModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AIRPORT_CODES = Object.freeze(['MIA', 'FLL', 'PBI']);

  // ---------------------------------------------------------------- utils

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return value;
  }

  function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(deepClone);
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }

  function ownProp(obj, key) {
    return obj !== null && typeof obj === 'object' &&
      typeof key === 'string' &&
      Object.prototype.hasOwnProperty.call(obj, key);
  }

  function normText(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function isSupportedAirport(code) {
    return typeof code === 'string' && AIRPORT_CODES.indexOf(code) !== -1;
  }

  function nonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
  }

  // Complete a route tuple with the fields hydration does not supply. A
  // stored ride carries no selection-time coordinates or attributions, and
  // none are fabricated.
  function completeRouteTuple(route) {
    const out = deepClone(route);
    out.addressCoordinates = route.addressCoordinates
      ? { lat: route.addressCoordinates.lat, lng: route.addressCoordinates.lng }
      : null;
    out.addressAttributions = Array.isArray(route.addressAttributions)
      ? deepClone(route.addressAttributions)
      : [];
    return out;
  }

  // ------------------------------------------------------- route adapters
  //
  // ONE discriminated Route union. "One canonical Route model" does not mean
  // one kind: legacy_unclassified_v1 is a NON-SELLABLE member, because the
  // installed writer still produces legacy_text rows today on any
  // non-verified write (migration 018:1206-1211) and neither the labels nor
  // the stored booking_mode prove a route family. Calling such a row an
  // airport transfer would assert provenance the database does not possess.
  //
  // Every kind implements the SAME six operations as OWN callable methods.

  function canonicalFromRouteDraft(routeDraft) {
    if (!routeDraft || !routeDraft.address) return null;
    const mode = routeDraft.mode;
    if (mode !== 'pickup' && mode !== 'dropoff') return null;
    if (!isSupportedAirport(routeDraft.airport)) return null;
    if (!nonEmptyString(routeDraft.address.placeId)) return null;
    const label = normText(routeDraft.address.label);
    if (!label) return null;
    const coords = routeDraft.address.coordinates;
    // The airport-side label is the HOST's display text when the editor
    // supplies one (routeDraft.airportLabel: seeded from the stored
    // projection, replaced by the host's airport name only on an airport
    // tap), never a label re-synthesized from the code. The code is the
    // fallback for a draft that carries no display label.
    const airportLabel = nonEmptyString(normText(routeDraft.airportLabel))
      ? routeDraft.airportLabel
      : routeDraft.airport;
    return {
      kind: 'airport_transfer_v1',
      authority: 'canonical',
      bookingMode: mode,
      airportCode: routeDraft.airport,
      canonicalPlaceId: routeDraft.address.placeId,
      pickupLabel: mode === 'pickup' ? airportLabel : label,
      dropoffLabel: mode === 'pickup' ? label : airportLabel,
      addressCoordinates: coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)
        ? { lat: coords.lat, lng: coords.lng }
        : null,
      addressAttributions: Array.isArray(routeDraft.address.attributions)
        ? deepClone(routeDraft.address.attributions)
        : []
    };
  }

  const airportTransferV1 = {
    kind: 'airport_transfer_v1',

    projectRoute(route) {
      // The airport side projects the STORED label byte for byte (what
      // create persisted, e.g. "Miami International"): the card writes this
      // projection back on every save, so a time-only edit must round-trip
      // the stored text exactly. Synthesizing the label from the code here
      // silently rewrote pickup/dropoff_location on unchanged routes (Codex
      // seq:234 #2). The code is only the fallback for a tuple whose
      // airport side carries no label.
      const storedAirportLabel = route.bookingMode === 'pickup' ? route.pickupLabel : route.dropoffLabel;
      const airport = {
        label: nonEmptyString(storedAirportLabel) ? storedAirportLabel : route.airportCode,
        placeId: null,
        attributions: []
      };
      const address = {
        label: route.bookingMode === 'pickup' ? route.dropoffLabel : route.pickupLabel,
        placeId: route.canonicalPlaceId,
        attributions: Array.isArray(route.addressAttributions)
          ? deepClone(route.addressAttributions)
          : []
      };
      return route.bookingMode === 'pickup'
        ? { origin: airport, destination: address }
        : { origin: address, destination: airport };
    },

    fromRouteDraft: canonicalFromRouteDraft,

    // Applied ONLY to a successful quote response, after that response has
    // passed its ORIGINAL request-key staleness check. Never on a failed or
    // stale quote.
    adoptCanonicalPlaceId(route, quoteIntent) {
      if (!quoteIntent || !nonEmptyString(quoteIntent.placeId)) return route;
      if (quoteIntent.placeId === route.canonicalPlaceId) return route;
      const next = deepClone(route);
      next.canonicalPlaceId = quoteIntent.placeId;
      return next;
    },

    toQuoteIntent(route) {
      return {
        mode: route.bookingMode,
        airportCode: route.airportCode,
        placeId: route.canonicalPlaceId
      };
    },

    // Kind-namespaced, so converting a legacy route reads as a genuine route
    // change rather than a hidden mutation. Labels are deliberately NOT in
    // identity - the signed commitment excludes them too - and an
    // identity-equal route restores the whole snapshot tuple upstream.
    routeIdentity(route) {
      return JSON.stringify([
        'airport_transfer_v1',
        route.bookingMode,
        route.airportCode,
        route.canonicalPlaceId
      ]);
    },

    routeIsComplete(route) {
      if (!route) return false;
      if (route.bookingMode !== 'pickup' && route.bookingMode !== 'dropoff') return false;
      return isSupportedAirport(route.airportCode) && nonEmptyString(route.canonicalPlaceId);
    }
  };

  const legacyUnclassifiedV1 = {
    kind: 'legacy_unclassified_v1',

    // Projects the two stored labels for display and nothing more. The
    // stored booking_mode only orders the two labels; it asserts no family.
    projectRoute(route) {
      return {
        origin: { label: route.pickupLabel, placeId: null, attributions: [] },
        destination: { label: route.dropoffLabel, placeId: null, attributions: [] }
      };
    },

    // This kind has no editor of its own: the Where screen produces a
    // canonical route. A COMPLETE fresh selection therefore converts the
    // legacy draft up to airport_transfer_v1 through this single
    // fromRouteDraft path - which is exactly why kind-namespaced identity
    // records the conversion as a real change. An incomplete selection
    // converts nothing.
    fromRouteDraft: canonicalFromRouteDraft,

    // Fails closed: there is no canonical identity to adopt.
    adoptCanonicalPlaceId() {
      return null;
    },

    // Never quotable.
    toQuoteIntent() {
      return null;
    },

    routeIdentity(route) {
      return JSON.stringify([
        'legacy_unclassified_v1',
        route.bookingMode,
        normText(route.pickupLabel),
        normText(route.dropoffLabel)
      ]);
    },

    routeIsComplete() {
      return false;
    }
  };

  const ADAPTER_OPS = Object.freeze([
    'projectRoute', 'fromRouteDraft', 'adoptCanonicalPlaceId',
    'toQuoteIntent', 'routeIdentity', 'routeIsComplete'
  ]);

  // Frozen, null-prototype registry with frozen bundles. Dispatch is
  // OWN-property and each of the six operations must be an OWN callable:
  // the rule is own-property, not a blocklist of the three prototype names
  // people remember, and an inherited bundle must not satisfy it either.
  const ROUTE_ADAPTERS = deepFreeze(Object.assign(Object.create(null), {
    airport_transfer_v1: Object.freeze(airportTransferV1),
    legacy_unclassified_v1: Object.freeze(legacyUnclassifiedV1)
  }));

  function adapterFor(kind) {
    if (typeof kind !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(ROUTE_ADAPTERS, kind)) return null;
    const adapter = ROUTE_ADAPTERS[kind];
    for (const op of ADAPTER_OPS) {
      if (!Object.prototype.hasOwnProperty.call(adapter, op)) return null;
      if (typeof adapter[op] !== 'function') return null;
    }
    return adapter;
  }

  // --------------------------------------------------- snapshot and draft

  function createSnapshot(dto) {
    if (!dto || typeof dto !== 'object') return null;
    if (!dto.route || !adapterFor(dto.route.kind)) return null;
    const snap = deepClone(dto);
    snap.route = completeRouteTuple(dto.route);
    return deepFreeze(snap);
  }

  function createDraft(snapshot) {
    if (!snapshot) return null;
    const draft = deepClone(snapshot);
    // Carried opaquely: validated so it round-trips, never rendered, never
    // passenger demand, never part of quote intent.
    draft.bags = snapshot.bags;
    return draft;
  }

  // ------------------------------------------------------- the comparator
  //
  // Snapshot-relative, and the ONLY source of: the change set, the
  // before/after lines, and whether a quote is needed. Route comparison goes
  // through the adapter's identity; generic code never reads
  // bookingMode/airportCode/canonicalPlaceId itself.

  // ONE value over the normalized traveler AND the explicit booker
  // presence/name/phone, so an absent booker and a present-but-blank booker
  // are distinguishable and no field can collide into another.
  function travelerKey(traveler, booker) {
    return JSON.stringify({
      traveler: traveler ? {
        name: normText(traveler.name),
        phone: normText(traveler.phone),
        email: normText(traveler.email)
      } : null,
      bookerPresent: !!booker,
      booker: booker ? {
        name: normText(booker.name),
        phone: normText(booker.phone)
      } : null
    });
  }

  function compareDraft(snapshot, draft) {
    const changed = [];
    if (!snapshot || !draft) return { changed, isComplete: false, needsQuote: false };

    const snapAdapter = adapterFor(snapshot.route && snapshot.route.kind);
    const draftAdapter = adapterFor(draft.route && draft.route.kind);
    if (!snapAdapter || !draftAdapter) return { changed, isComplete: false, needsQuote: false };

    if (snapAdapter.routeIdentity(snapshot.route) !== draftAdapter.routeIdentity(draft.route)) {
      changed.push('route');
    }
    if (new Date(snapshot.pickupAt).getTime() !== new Date(draft.pickupAt).getTime()) {
      changed.push('pickupAt');
    }
    if (snapshot.passengers !== draft.passengers) changed.push('passengers');
    if (snapshot.vehicle.key !== draft.vehicle.key) changed.push('vehicle');
    if (travelerKey(snapshot.traveler, snapshot.booker) !== travelerKey(draft.traveler, draft.booker)) {
      changed.push('traveler');
    }

    const isComplete = draftAdapter.routeIsComplete(draft.route);
    return {
      changed,
      isComplete,
      // A quote is needed only for a COMPLETE intent that differs from the
      // snapshot. An incomplete route (every legacy row) buys nothing.
      needsQuote: changed.length > 0 && isComplete
    };
  }

  // ------------------------------------- root-scoped Miami time controller
  //
  // UNUSED in PR-A. Root-scoped by construction: it takes explicit element
  // references, never global ids, so two instances cannot collide. All
  // semantics are America/New_York regardless of the device clock - a
  // snapshot instant is preselected by its MIAMI wall clock, never by its
  // UTC date.

  const MIAMI_TZ = 'America/New_York';

  function zoneAbbrev(date) {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: MIAMI_TZ, timeZoneName: 'short' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  }

  function miamiParts(date) {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: MIAMI_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date);
    const get = (t) => Number(f.find((p) => p.type === t).value);
    return {
      year: get('year'), month: get('month'), day: get('day'),
      hour: get('hour') % 24, minute: get('minute')
    };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function miamiDateValue(parts) {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  function miamiTimeValue(parts) {
    return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  }

  function sameWallClock(a, b) {
    return a.year === b.year && a.month === b.month && a.day === b.day &&
      a.hour === b.hour && a.minute === b.minute;
  }

  // Resolve a Miami wall-clock time to the instants that actually exist.
  // Spring forward: the skipped hour resolves to NOTHING (it never happened).
  // Fall back: the repeated hour resolves to TWO instants, offered once each
  // and labelled EDT/EST so the passenger can tell them apart.
  function resolveMiamiWallClock(wall) {
    const results = [];
    for (const offsetHours of [4, 5]) {
      const guess = new Date(Date.UTC(
        wall.year, wall.month - 1, wall.day, wall.hour + offsetHours, wall.minute, 0, 0
      ));
      if (sameWallClock(miamiParts(guess), wall) &&
        !results.some((r) => r.getTime() === guess.getTime())) {
        results.push(guess);
      }
    }
    return results.map((instant) => ({
      instant,
      iso: instant.toISOString(),
      label: zoneAbbrev(instant)
    }));
  }

  function formatMiami(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (!Number.isFinite(d.getTime())) return '';
    const body = new Intl.DateTimeFormat('en-US', {
      timeZone: MIAMI_TZ, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(d);
    return `${body} ${zoneAbbrev(d)}`;
  }

  // els: { dateInput, timeInput } - explicit references, no global lookup.
  function createEditTimeController(els, options) {
    const onPick = options && typeof options.onPick === 'function' ? options.onPick : null;
    let selectedIso = null;

    function writeControls(iso) {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return;
      const parts = miamiParts(d);
      if (els && els.dateInput) els.dateInput.value = miamiDateValue(parts);
      if (els && els.timeInput) els.timeInput.value = miamiTimeValue(parts);
    }

    return {
      // Preselects the snapshot instant by its MIAMI wall clock, so a ride
      // at 11:30 PM Miami never shows the following UTC date.
      setFromSnapshot(iso) {
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return null;
        selectedIso = d.toISOString();
        writeControls(selectedIso);
        return selectedIso;
      },
      candidates(wall) {
        return resolveMiamiWallClock(wall);
      },
      pick(iso) {
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return null;
        selectedIso = d.toISOString();
        writeControls(selectedIso);
        if (onPick) onPick(selectedIso);
        return selectedIso;
      },
      selected() { return selectedIso; },
      miamiParts(iso) { return miamiParts(new Date(iso)); },
      format: formatMiami
    };
  }

  return {
    AIRPORT_CODES,
    miamiParts,
    deepFreeze,
    deepClone,
    ownProp,
    completeRouteTuple,
    ROUTE_ADAPTERS,
    ADAPTER_OPS,
    adapterFor,
    createSnapshot,
    createDraft,
    compareDraft,
    travelerKey,
    resolveMiamiWallClock,
    formatMiami,
    createEditTimeController,
    MIAMI_TZ
  };
}));
