// PR-B — the Manage Ride / Edit Ride REVIEW CARD (plan v8.6 §3C, §3E).
//
// One screen, one place, and it is the review. The snapshot the server hands
// back through the hydration GET becomes the draft; the draft is the ONLY
// thing the passenger edits; and every submitted byte is built from an
// immutable attempt frozen off that draft immediately before the POST.
// Nothing here reads the create flow's PassengerModal singleton, the live
// `state.locations`, `state.vehicle`, or any other page state as an
// authority — that is the class of defect the previous PR-B tree had, where
// a time-only edit could rewrite the traveler, the vehicle and the bags.
//
// Dependencies are INJECTED so the whole controller runs under `vm` with a
// fake DOM in tests, and so the paid surface can be proved by counting the
// injected fetch. Nothing is read from globals except through `deps`.
//
// Safe sinks: every dynamic value reaches the DOM through textContent or
// `.value`. Static markup is the only innerHTML.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PendingEditCard = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const QUOTE_DEBOUNCE_MS = 500;

  // Typed refusal copy (§ "Refusal copy is typed, never raw"). Nothing the
  // server sends as free text is ever rendered.
  const COPY = Object.freeze({
    loading: 'Loading your ride…',
    reselect: 'Re-select your address to continue',
    chooseTime: 'Choose a pickup time',
    updating: 'Updating price…',
    noChanges: 'No changes yet',
    gettingPrices: 'Getting current prices…',
    quoteFailed: 'Could not get a price right now',
    quoteUnavailable: 'Pricing is unavailable right now. Please contact LinkMia to change this ride.',
    elapsed: 'This pickup time has passed. Choose a new time to continue.',
    profileNoPhone: 'Add a phone number to your profile to travel yourself',
    profileNoEmail: 'Add an email address to your account to travel yourself',
    staleEmail: 'Add an email for this traveler, or keep the current traveler',
    changedElsewhere: 'This ride changed elsewhere. We loaded the latest details; your unsaved changes were not applied.',
    priceChanged: 'The price changed — review it and tap Save again.',
    nonexistentTime: 'That time does not exist on this date. Choose another time.',
    ambiguousTime: 'This time happens twice tonight. Choose which one.',
    failedLoad: 'We couldn’t load the latest ride details. Your ride is unchanged.',
    notSaved: 'Changes not saved. Your original ride is unchanged.',
    saveBusy: 'Saving…',
    saveIdle: 'Save changes',
    saveRefresh: 'Refresh and Save'
  });

  const CAPACITY_CODES = Object.freeze({
    passenger_capacity_exceeded: (n) => `Choose a vehicle that fits ${n} passengers`,
    bag_capacity_exceeded: () => 'Choose a vehicle with more luggage space'
  });

  function normText(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function money(cents) {
    if (!Number.isSafeInteger(cents)) return '';
    return '$' + (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // Google Maps credit + every third-party attribution the selected place
  // carries, built exactly as autocomplete.js renderThirdPartyAttributions
  // does: createElement, textContent, https-only anchors.
  function renderAttribution(doc, attributions) {
    const holder = el(doc, 'div', 'pe-attribution');
    holder.setAttribute('translate', 'no');
    holder.appendChild(doc.createTextNode('Google Maps'));
    if (Array.isArray(attributions)) {
      for (const entry of attributions) {
        if (!entry || !Array.isArray(entry.segments)) continue;
        holder.appendChild(doc.createTextNode(' · '));
        for (const segment of entry.segments) {
          const text = typeof (segment && segment.text) === 'string' ? segment.text : '';
          if (!text) continue;
          const href = typeof (segment && segment.href) === 'string' && /^https:\/\//i.test(segment.href)
            ? segment.href : null;
          if (href) {
            const a = doc.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = text;
            holder.appendChild(a);
          } else {
            holder.appendChild(doc.createTextNode(text));
          }
        }
      }
    }
    return holder;
  }

  function createPendingEditCard(deps) {
    const {
      model,             // PendingEditModel
      document: doc,
      fetch: fetchImpl,
      getSession,        // async () => { access_token, user } | null
      app,               // the AirportBookingApp instance (narrow surface, see below)
      accountIdentity,   // () => { name, phone, email, ambassador: bool }
      now = () => Date.now(),
      setTimeout: setT = (fn, ms) => setTimeout(fn, ms),
      clearTimeout: clearT = (id) => clearTimeout(id),
      randomUUID
    } = deps;

    // ---- session state -----------------------------------------------------
    let ctx = null;            // { bookingId, tripCode }
    let snapshot = null;       // frozen
    let draft = null;          // mutable, the passenger's working copy
    let generation = 0;        // bumped on close/handoff; async work checks it
    let mount = null;          // the card's root element
    let held = null;           // ONE held quote slot: { key, data, expiresAt, seq }
    let quoteSeq = 0;
    let quoteTimer = null;
    let quoteState = 'idle';   // idle | loading | ready | error
    let quoteError = null;     // { retryable, code }
    let vehiclesOpen = false;
    let travelerConfirmedKey = null;
    let submitInFlight = false;
    let refreshUsedThisTap = false;
    let resubmitUsedThisTap = false;
    let elapsedRefusal = false;
    let whereOpen = false;
    let ui = null;
    // P0 (Codex seq:191 #1): the save chain is CLAIMED at the first tap,
    // synchronously, before any await — and every edit control is inert
    // until the chain ends. Only an active traveler-confirmation sheet may
    // stay operable. Without this, a tap at 7:15 followed by a change to
    // 8:00 during the auth await would POST 7:15 while the card showed 8:00.
    let saveChainActive = false;
    const chainBusy = () => saveChainActive || submitInFlight;
    // P0 (Codex seq:191 #3): an unresolved wall time must never let the
    // previous valid instant quote or save behind the passenger's back.
    // 'resolved' | 'blank' | 'gap' | 'fold'
    let timeResolution = 'resolved';

    const adapter = () => model.adapterFor(draft && draft.route && draft.route.kind);

    // ---- intent / keys -----------------------------------------------------
    function draftIntent() {
      const a = adapter();
      if (!a || !draft) return null;
      const routeIntent = a.toQuoteIntent(draft.route);
      if (!routeIntent) return null;
      const t = Date.parse(draft.pickupAt);
      if (!Number.isFinite(t)) return null;
      // The adapter's quote projection is passed through OPAQUELY: the card
      // never enumerates its route fields (plan v8.6 §3B seam).
      return {
        ...routeIntent,
        pickupAt: new Date(t).toISOString(),
        passengers: draft.passengers
      };
    }

    function intentKey(intent) {
      if (!intent) return null;
      const a = adapter();
      if (!a) return null;
      // Route keyed by the ADAPTER-OWNED identity, never by route fields.
      return JSON.stringify([a.routeIdentity(draft.route), intent.pickupAt,
        intent.passengers, 'edit', ctx.bookingId, snapshot.detailsVersion]);
    }

    function comparison() {
      return model.compareDraft(snapshot, draft);
    }

    function heldIsCurrent() {
      return !!held && held.key === intentKey(draftIntent());
    }
    function heldIsFresh() {
      return heldIsCurrent() && now() < held.expiresAt;
    }

    function selectedVehicleEntry() {
      if (!heldIsCurrent()) return null;
      const v = held.data.vehicles[draft.vehicle.key];
      return v && v.ok ? v : null;
    }

    function fleetMaxPassengers() {
      return (snapshot.vehicles || []).reduce((m, v) => Math.max(m, v.passengerCapacity || 0), 1);
    }

    function resolvedCardVehicle(key) {
      return (snapshot.vehicles || []).find((v) => v.key === key) || null;
    }

    // ---- paid surface ------------------------------------------------------
    // The ONE predicate that permits a paid quote from this surface.
    function quoteSurfaceActive() {
      return !!(app.quoteFlowActive() && snapshot && draft && mount && mount.isConnected !== false &&
        !whereOpen && generation === mountGeneration);
    }
    let mountGeneration = 0;

    function scheduleQuote() {
      if (!quoteSurfaceActive()) return;
      clearT(quoteTimer);
      quoteTimer = setT(() => executeComparator(), QUOTE_DEBOUNCE_MS);
    }

    // The comparator runs at debounce EXECUTION time and is the only thing
    // that decides whether a call is made.
    function executeComparator() {
      quoteTimer = null;
      if (!quoteSurfaceActive()) { render(); return; }
      const cmp = comparison();
      if (!cmp.isComplete || timeResolution !== 'resolved') { render(); return; }
      if (cmp.changed.length === 0 && !vehiclesOpen) { render(); return; }
      const key = intentKey(draftIntent());
      if (held && held.key === key) { render(); return; }   // expired-but-complete is NOT re-bought here
      requestQuote({ reason: cmp.changed.length ? 'change' : 'expansion' });
    }

    async function requestQuote({ force = false } = {}) {
      if (!quoteSurfaceActive() || timeResolution !== 'resolved') return false;
      const intent = draftIntent();
      const key = intentKey(intent);
      if (!intent) return false;
      if (!force && held && held.key === key && now() < held.expiresAt) return true;

      const seq = ++quoteSeq;
      const gen = generation;
      quoteState = 'loading';
      quoteError = null;
      render();
      try {
        const session = await getSession();
        if (seq !== quoteSeq || gen !== generation) return false;
        if (!quoteSurfaceActive() || !session || !session.access_token) {
          quoteState = held ? 'ready' : 'idle';
          render();
          return false;
        }
        if (intentKey(draftIntent()) !== key) return false;

        const res = await fetchImpl('/api/quote-ride', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify({ ...intent, bookingId: ctx.bookingId,
            expectedDetailsVersion: snapshot.detailsVersion })
        });
        if (seq !== quoteSeq || gen !== generation) return false;
        let payload = null;
        try { payload = await res.json(); } catch (_) { payload = null; }
        if (seq !== quoteSeq || gen !== generation) return false;
        if (intentKey(draftIntent()) !== key) return false;

        if (!res.ok) {
          if (payload && payload.error === 'edit_stale') {
            if (payload.reason === 'not_editable') {
              lifecycleHandoff(payload.currentStatus || null);
              return false;
            }
            if (payload.reason === 'version') {
              await casConflict();
              return false;
            }
          }
          if (res.status === 400 && payload && payload.error === 'pickup_time_elapsed') {
            markElapsed();
            return false;
          }
          quoteState = 'error';
          quoteError = { retryable: res.status >= 500 || res.status === 429, code: null };
          render();
          return false;
        }

        const quote = payload && payload.quote;
        if (!app.serverQuoteIsComplete(quote)) {
          quoteState = 'error';
          quoteError = { retryable: false, code: 'incomplete' };
          render();
          return false;
        }

        // Canonical Place-ID adoption is response normalization, not a
        // passenger mutation: adopt, collapse to the snapshot tuple when the
        // identity is now equal, then re-key the held quote — synchronously,
        // followed by ONE render. Never marks dirty, never schedules again.
        const a = adapter();
        if (a && quote.intent && typeof quote.intent === 'object') {
          // The WHOLE server intent is handed to the adapter; the card does
          // not know which of its fields carries the canonical identity.
          const adopted = a.adoptCanonicalPlaceId(draft.route, quote.intent);
          if (adopted) {
            const snapA = model.adapterFor(snapshot.route.kind);
            if (snapA && snapA.routeIdentity(snapshot.route) === a.routeIdentity(adopted)) {
              draft.route = model.deepClone(snapshot.route);
            } else {
              draft.route = adopted;
            }
          }
        }
        held = {
          key: intentKey(draftIntent()),
          data: quote,
          expiresAt: earliestExpiry(quote),
          seq
        };
        quoteState = 'ready';
        quoteError = null;
        elapsedRefusal = false;
        render();
        return true;
      } catch (_) {
        if (seq !== quoteSeq || gen !== generation) return false;
        quoteState = 'error';
        quoteError = { retryable: true, code: null };
        render();
        return false;
      }
    }

    function earliestExpiry(quote) {
      let earliest = null;
      Object.keys(quote.vehicles || {}).forEach((k) => {
        const t = Date.parse((quote.vehicles[k] && quote.vehicles[k].expiresAt) || '');
        if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
      });
      return earliest === null ? 0 : earliest;
    }

    function markElapsed() {
      elapsedRefusal = true;
      held = null;
      quoteState = 'idle';
      render();
      if (ui && ui.timeInput && typeof ui.timeInput.focus === 'function') ui.timeInput.focus();
    }

    // ---- lifecycle handoffs ------------------------------------------------
    function lifecycleHandoff(currentStatus) {
      const g = generation;
      close();
      if (g !== generation - 1) return;
      app.handleLifecycleHandoff(currentStatus);
    }

    // A CAS conflict is not a lifecycle change: zero paid retries, never adopt
    // the returned version into the old draft, discard, ONE fresh hydration.
    async function casConflict() {
      const bookingId = ctx.bookingId;
      const tripCode = ctx.tripCode;
      close();
      const dto = await app.fetchRideSnapshot(bookingId);
      if (!dto) { app.failClosedFromEdit(COPY.failedLoad); return; }
      if (dto.notEditable) { app.handleLifecycleHandoff(dto.currentStatus); return; }
      open(dto, { bookingId, tripCode });
      setReason(COPY.changedElsewhere, true);
    }

    // ---- open / close ------------------------------------------------------
    function open(dto, context) {
      close();
      ctx = { bookingId: context.bookingId, tripCode: context.tripCode || dto.tripCode || '' };
      snapshot = model.createSnapshot(dto);
      draft = model.createDraft(snapshot);
      held = null;
      quoteState = 'idle';
      quoteError = null;
      vehiclesOpen = false;
      travelerConfirmedKey = null;
      elapsedRefusal = false;
      whereOpen = false;
      saveChainActive = false;
      timeResolution = 'resolved';
      mountGeneration = generation;
      buildDom();
      render();
      // ZERO quote calls on open: nothing is scheduled here.
    }

    function close() {
      generation++;
      closeSheet(true);
      clearT(quoteTimer);
      quoteTimer = null;
      quoteSeq++;
      if (mount && mount.parentNode) mount.parentNode.removeChild(mount);
      mount = null;
      ui = null;
      snapshot = null;
      draft = null;
      held = null;
      ctx = null;
    }

    // ---- DOM ---------------------------------------------------------------
    function buildDom() {
      mount = el(doc, 'section', 'pending-edit-card');
      mount.id = 'pendingEditCard';
      mount.setAttribute('aria-label', 'Manage ride');

      ui = {};
      ui.title = el(doc, 'h2', 'pe-title');
      mount.appendChild(ui.title);

      // 1. Route
      ui.routeLine = el(doc, 'div', 'pe-line pe-route');
      ui.routeText = el(doc, 'div', 'pe-line-text');
      ui.routeChange = el(doc, 'button', 'pe-change', 'Change');
      ui.routeChange.type = 'button';
      ui.routeChange.addEventListener('click', openWhere);
      ui.routeLine.appendChild(ui.routeText);
      ui.routeLine.appendChild(ui.routeChange);
      ui.routeAttribution = el(doc, 'div', 'pe-attribution-slot');
      mount.appendChild(ui.routeLine);
      mount.appendChild(ui.routeAttribution);

      // 2. Time (America/New_York controller)
      ui.timeLine = el(doc, 'div', 'pe-line pe-time');
      ui.timeText = el(doc, 'div', 'pe-line-text');
      ui.dateInput = doc.createElement('input');
      ui.dateInput.type = 'date';
      ui.dateInput.className = 'pe-date';
      ui.dateInput.setAttribute('aria-label', 'Pickup date');
      ui.timeInput = doc.createElement('input');
      ui.timeInput.type = 'time';
      ui.timeInput.step = '900';
      ui.timeInput.className = 'pe-time-input';
      ui.timeInput.setAttribute('aria-label', 'Pickup time');
      ui.timeChoice = el(doc, 'div', 'pe-time-choice');
      ui.timeLine.appendChild(ui.timeText);
      ui.timeLine.appendChild(ui.dateInput);
      ui.timeLine.appendChild(ui.timeInput);
      mount.appendChild(ui.timeLine);
      mount.appendChild(ui.timeChoice);
      ui.controller = model.createEditTimeController(
        { dateInput: ui.dateInput, timeInput: ui.timeInput }, { onPick: onTimePicked });
      ui.controller.setFromSnapshot(snapshot.pickupAt);
      const onTimeChange = () => resolveTimeInputs();
      ui.dateInput.addEventListener('change', onTimeChange);
      ui.timeInput.addEventListener('change', onTimeChange);

      // 3. Vehicle (collapsed)
      ui.vehicleLine = el(doc, 'div', 'pe-line pe-vehicle');
      ui.vehicleText = el(doc, 'div', 'pe-line-text');
      ui.vehicleToggle = el(doc, 'button', 'pe-change', 'Change vehicle');
      ui.vehicleToggle.type = 'button';
      ui.vehicleToggle.addEventListener('click', toggleVehicles);
      ui.vehicleLine.appendChild(ui.vehicleText);
      ui.vehicleLine.appendChild(ui.vehicleToggle);
      ui.vehicleOptions = el(doc, 'div', 'pe-vehicle-options');
      ui.vehicleOptions.setAttribute('role', 'radiogroup');
      mount.appendChild(ui.vehicleLine);
      mount.appendChild(ui.vehicleOptions);

      // 4. Passengers
      ui.paxLine = el(doc, 'div', 'pe-line pe-pax');
      ui.paxText = el(doc, 'div', 'pe-line-text');
      ui.paxEdit = el(doc, 'button', 'pe-change', 'Edit');
      ui.paxEdit.type = 'button';
      ui.paxStepper = el(doc, 'div', 'pe-stepper');
      ui.paxMinus = el(doc, 'button', 'pe-step', '−');
      ui.paxMinus.type = 'button';
      ui.paxMinus.setAttribute('aria-label', 'Fewer passengers');
      ui.paxValue = el(doc, 'span', 'pe-step-value');
      ui.paxPlus = el(doc, 'button', 'pe-step', '+');
      ui.paxPlus.type = 'button';
      ui.paxPlus.setAttribute('aria-label', 'More passengers');
      ui.paxStepper.appendChild(ui.paxMinus);
      ui.paxStepper.appendChild(ui.paxValue);
      ui.paxStepper.appendChild(ui.paxPlus);
      ui.paxStepper.hidden = true;
      ui.paxEdit.addEventListener('click', () => { if (chainBusy()) return; ui.paxStepper.hidden = !ui.paxStepper.hidden; render(); });
      ui.paxMinus.addEventListener('click', () => stepPassengers(-1));
      ui.paxPlus.addEventListener('click', () => stepPassengers(1));
      ui.paxLine.appendChild(ui.paxText);
      ui.paxLine.appendChild(ui.paxEdit);
      mount.appendChild(ui.paxLine);
      mount.appendChild(ui.paxStepper);

      // 5. Traveler; notes / sign (read-only)
      ui.travelerLine = el(doc, 'div', 'pe-line pe-traveler');
      ui.travelerText = el(doc, 'div', 'pe-line-text');
      ui.travelerEdit = el(doc, 'button', 'pe-change', 'Edit');
      ui.travelerEdit.type = 'button';
      ui.travelerEdit.addEventListener('click', () => { if (!chainBusy()) openTravelerSheet('edit'); });
      ui.travelerLine.appendChild(ui.travelerText);
      ui.travelerLine.appendChild(ui.travelerEdit);
      mount.appendChild(ui.travelerLine);
      ui.notesLine = el(doc, 'div', 'pe-line pe-notes pe-readonly');
      ui.signLine = el(doc, 'div', 'pe-line pe-sign pe-readonly');
      mount.appendChild(ui.notesLine);
      mount.appendChild(ui.signLine);

      // 7. Changes + Save
      ui.changes = el(doc, 'div', 'pe-changes');
      ui.changes.setAttribute('aria-live', 'polite');
      mount.appendChild(ui.changes);
      ui.status = el(doc, 'div', 'pe-quote-status');
      ui.status.setAttribute('role', 'status');
      mount.appendChild(ui.status);
      ui.save = el(doc, 'button', 'pe-save', COPY.saveIdle);
      ui.save.type = 'button';
      ui.save.addEventListener('click', onSaveTap);
      mount.appendChild(ui.save);
      ui.reason = el(doc, 'div', 'pe-reason');
      ui.reason.setAttribute('aria-live', 'polite');
      mount.appendChild(ui.reason);
      ui.actions = el(doc, 'div', 'pe-actions');
      ui.discard = el(doc, 'button', 'pe-secondary', 'Discard changes');
      ui.discard.type = 'button';
      ui.discard.addEventListener('click', onDiscard);
      ui.actions.appendChild(ui.discard);
      mount.appendChild(ui.actions);

      app.mountEditCard(mount);
    }

    // ---- interactions ------------------------------------------------------
    function onTimePicked(iso) {
      if (!draft || chainBusy()) return;
      draft.pickupAt = iso;
      timeResolution = 'resolved';
      elapsedRefusal = false;
      setReason('', false);        // a valid pick clears the sticky invalid-time reason
      clear(ui.timeChoice);
      scheduleQuote();
      render();
    }

    // A date+time pair is a Miami WALL CLOCK; the controller resolves it to
    // 0 (nonexistent), 1, or 2 (fall-back fold) instants.
    function resolveTimeInputs() {
      if (!draft || chainBusy()) return;
      const d = String(ui.dateInput.value || '');
      const t = String(ui.timeInput.value || '');
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      const tm = /^(\d{2}):(\d{2})/.exec(t);
      clear(ui.timeChoice);
      clearT(quoteTimer); quoteTimer = null;   // nothing queued may price a dead instant
      if (!dm || !tm) {
        timeResolution = 'blank';
        draft.pickupAt = null;                 // the old instant is NOT kept behind the controls
        setReason('', false);
        render();
        return;
      }
      const wall = { year: +dm[1], month: +dm[2], day: +dm[3], hour: +tm[1], minute: +tm[2] };
      const cands = ui.controller.candidates(wall);
      if (cands.length === 1) { ui.controller.pick(cands[0].iso); return; }
      if (cands.length === 0) {
        timeResolution = 'gap';
        draft.pickupAt = null;
        setReason(COPY.nonexistentTime, true);
        render();
        return;
      }
      timeResolution = 'fold';
      draft.pickupAt = null;                   // unresolved until exactly one instant is chosen
      setReason(COPY.ambiguousTime, true);     // replaces any earlier sticky (e.g. a gap) reason
      const note = el(doc, 'div', 'pe-choice-note', COPY.ambiguousTime);
      ui.timeChoice.appendChild(note);
      for (const c of cands) {
        const b = el(doc, 'button', 'pe-choice', `${model.formatMiami(c.iso)}`);
        b.type = 'button';
        b.addEventListener('click', () => ui.controller.pick(c.iso));
        ui.timeChoice.appendChild(b);
      }
      render();
    }

    function stepPassengers(delta) {
      if (!draft || chainBusy()) return;
      const max = fleetMaxPassengers();
      const next = Math.min(max, Math.max(1, draft.passengers + delta));
      if (next === draft.passengers) return;
      draft.passengers = next;
      scheduleQuote();   // never touches the held quote; the comparator decides
      render();
    }

    function toggleVehicles() {
      if (chainBusy()) return;
      vehiclesOpen = !vehiclesOpen;
      if (vehiclesOpen) {
        // The sole deliberate no-change quote: first expansion, complete
        // intent, no fresh same-intent held quote.
        const cmp = comparison();
        if (cmp.isComplete && !heldIsFresh()) scheduleQuote();
      }
      render();
    }

    function chooseVehicle(key) {
      if (!draft || chainBusy() || !resolvedCardVehicle(key)) return;
      draft.vehicle = { key, name: resolvedCardVehicle(key).name };
      vehiclesOpen = false;
      scheduleQuote();
      render();
    }

    function onDiscard() {
      if (chainBusy()) return;
      const g = generation;
      const id = ctx && ctx.bookingId;
      close();
      app.editCardClosed(id, g);
    }

    // ---- Where overlay (edit-route mode, driven by routeDraft) ------------
    function openWhere() {
      if (!draft || chainBusy()) return;
      const a = adapter();
      if (!a) return;
      // The card carries Route OPAQUELY. The host's editor (today: the
      // airport Where screen) receives the route plus the adapter's own
      // projections and builds whatever temporary draft its shape needs;
      // this generic card never reads a shape-specific route field.
      const editorInput = {
        route: model.deepClone(draft.route),
        projection: a.projectRoute(draft.route),
        quoteIntent: a.toQuoteIntent(draft.route)
      };
      whereOpen = true;
      clearT(quoteTimer);
      quoteTimer = null;
      app.enterEditRouteMode(editorInput, {
        onDone: (finalDraft) => {
          whereOpen = false;
          const ad = adapter();
          const fresh = ad ? ad.fromRouteDraft(finalDraft) : null;
          if (fresh) {
            const snapA = model.adapterFor(snapshot.route.kind);
            const freshA = model.adapterFor(fresh.kind);
            // Identity-equal (incl. a same-raw-id re-pick) → restore the
            // COMPLETE snapshot tuple: stored labels, zero quotes.
            if (snapA && freshA && snapA.routeIdentity(snapshot.route) === freshA.routeIdentity(fresh)) {
              draft.route = model.deepClone(snapshot.route);
            } else {
              draft.route = fresh;
            }
          }
          scheduleQuote();
          render();
        },
        onBack: () => {
          whereOpen = false;
          // Back discards routeDraft with zero mutation — but a change the
          // passenger made BEFORE opening Where (a new time, say) is still in
          // the draft. Let the comparator decide at execution: nothing changed
          // = zero calls; a real pending change = its one deferred quote.
          scheduleQuote();
          render();
        }
      });
      render();
    }

    // ---- traveler sheet (edit-scoped; never the create singleton) --------
    let sheet = null;
    let sheetDone = null;   // the active sheet's continuation, settled exactly once
    function openTravelerSheet(mode, onDone) {
      if (sheet) closeSheet(true);
      sheetDone = typeof onDone === 'function' ? onDone : null;
      onDone = (ok) => { const f = sheetDone; sheetDone = null; if (f) f(ok); };
      const account = accountIdentity() || {};
      const accountEmail = normText(account.email);
      const canSelf = !account.ambassador && !!normText(account.phone) && !!accountEmail;
      const selfReason = account.ambassador ? 'Ambassador accounts book rides for guests'
        : !normText(account.phone) ? COPY.profileNoPhone
          : !accountEmail ? COPY.profileNoEmail : '';

      const overlay = el(doc, 'div', 'pe-sheet-overlay');
      const panel = el(doc, 'div', 'pe-sheet-panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      const title = el(doc, 'h3', 'pe-sheet-title', mode === 'confirm' ? 'Confirm the traveler' : 'Who is traveling?');
      panel.appendChild(title);

      const selfBtn = el(doc, 'button', 'pe-sheet-option', 'Travel myself');
      selfBtn.type = 'button';
      selfBtn.disabled = !canSelf;
      if (!canSelf) {
        selfBtn.setAttribute('aria-describedby', 'peSelfReason');
      }
      panel.appendChild(selfBtn);
      if (!canSelf) {
        const r = el(doc, 'div', 'pe-sheet-reason', selfReason);
        r.id = 'peSelfReason';
        panel.appendChild(r);
      }

      const form = el(doc, 'form', 'pe-sheet-form');
      const nameIn = doc.createElement('input');
      nameIn.type = 'text'; nameIn.placeholder = 'Traveler name'; nameIn.autocomplete = 'name';
      nameIn.setAttribute('aria-label', 'Traveler name');
      const phoneIn = doc.createElement('input');
      phoneIn.type = 'tel'; phoneIn.placeholder = 'Traveler phone'; phoneIn.autocomplete = 'tel';
      phoneIn.setAttribute('aria-label', 'Traveler phone');
      const emailIn = doc.createElement('input');
      emailIn.type = 'email'; emailIn.placeholder = 'Traveler email'; emailIn.autocomplete = 'email';
      emailIn.setAttribute('aria-label', 'Traveler email');
      const t = draft.traveler || {};
      nameIn.value = t.name || '';
      phoneIn.value = t.phone || '';
      emailIn.value = t.email || '';
      const guestBtn = el(doc, 'button', 'pe-sheet-action', mode === 'confirm' ? 'Confirm traveler' : 'Use this traveler');
      guestBtn.type = 'submit';
      const emailReason = el(doc, 'div', 'pe-sheet-reason');
      emailReason.id = 'peEmailReason';
      form.appendChild(nameIn); form.appendChild(phoneIn); form.appendChild(emailIn);
      form.appendChild(emailReason);
      form.appendChild(guestBtn);
      panel.appendChild(form);

      const cancel = el(doc, 'button', 'pe-secondary', 'Back');
      cancel.type = 'button';
      panel.appendChild(cancel);
      overlay.appendChild(panel);
      doc.body.appendChild(overlay);
      sheet = { overlay, nameIn, phoneIn, emailIn, emailReason, guestBtn };

      const finish = (next) => {
        closeSheet();
        if (next) {
          draft.traveler = next.traveler;
          draft.booker = next.booker;
          travelerConfirmedKey = null;
          scheduleQuote();
        }
        render();
        if (onDone) onDone(!!next);
      };

      selfBtn.addEventListener('click', () => {
        if (!canSelf) return;
        finish({
          traveler: { name: normText(account.name), phone: normText(account.phone), email: accountEmail },
          booker: null   // self → the booker pair is CLEARED (the builder handles the wire rule)
        });
      });
      form.addEventListener('submit', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const name = normText(nameIn.value);
        const phone = normText(phoneIn.value);
        const email = normText(emailIn.value);
        if (!name || !phone) return;
        // no-stale-email rule: a blank guest email is allowed ONLY when the
        // snapshot email is already null.
        if (!email && snapshot.traveler && snapshot.traveler.email) {
          emailReason.textContent = COPY.staleEmail;
          return;
        }
        emailReason.textContent = '';
        if (mode === 'confirm' && name === normText(t.name) && phone === normText(t.phone) &&
            email === normText(t.email || '')) {
          // Confirmed without change: record the key and let Save continue.
          travelerConfirmedKey = model.travelerKey(draft.traveler, draft.booker);
          closeSheet();
          render();
          if (onDone) onDone(true);
          return;
        }
        finish({
          traveler: { name, phone, email: email || null },
          booker: { name: normText(account.name) || null, phone: normText(account.phone) || null }
        });
      });
      cancel.addEventListener('click', () => { closeSheet(); render(); if (onDone) onDone(false); });
    }

    // cancelled=true settles a still-pending continuation as "not confirmed"
    // — an external close (lifecycle handoff, Discard, a CAS rehydration)
    // must never leave the dialog on screen or a Save await hanging.
    function closeSheet(cancelled) {
      if (sheet && sheet.overlay && sheet.overlay.parentNode) sheet.overlay.parentNode.removeChild(sheet.overlay);
      sheet = null;
      if (cancelled && sheetDone) { const f = sheetDone; sheetDone = null; f(false); }
    }

    // ---- Save --------------------------------------------------------------
    function saveEligibility() {
      if (!snapshot || !draft) return { ok: false, reason: COPY.loading };
      const cmp = comparison();
      if (!cmp.isComplete) return { ok: false, reason: COPY.reselect };
      if (timeResolution === 'gap') return { ok: false, reason: COPY.nonexistentTime };
      if (timeResolution === 'fold') return { ok: false, reason: COPY.ambiguousTime };
      if (timeResolution !== 'resolved' || !Number.isFinite(Date.parse(draft.pickupAt))) {
        return { ok: false, reason: COPY.chooseTime };
      }
      if (elapsedRefusal) return { ok: false, reason: COPY.elapsed };
      if (cmp.changed.length === 0) return { ok: false, reason: COPY.noChanges };
      if (quoteState === 'loading') return { ok: false, reason: COPY.updating };
      if (submitInFlight) return { ok: false, reason: COPY.saveBusy };
      // no-stale-email rule at the gate too
      if (draft.traveler && !normText(draft.traveler.email) && snapshot.traveler && snapshot.traveler.email &&
          cmp.changed.includes('traveler')) {
        return { ok: false, reason: COPY.staleEmail };
      }
      if (!heldIsCurrent()) {
        return { ok: false, reason: quoteState === 'error' ? COPY.quoteFailed : COPY.updating };
      }
      const v = held.data.vehicles[draft.vehicle.key];
      if (!v || !v.ok) {
        return { ok: false, reason: capacityCopy(v && v.error) };
      }
      return { ok: true, stale: !heldIsFresh() };
    }

    function capacityCopy(err) {
      const code = err && err.code;
      const f = code && Object.prototype.hasOwnProperty.call(CAPACITY_CODES, code) ? CAPACITY_CODES[code] : null;
      return f ? f(draft.passengers) : 'This vehicle is not available for this ride';
    }

    async function onSaveTap() {
      if (chainBusy()) return;
      const elig0 = saveEligibility();
      if (!elig0.ok) { render(); return; }
      const gen = generation;
      // CLAIM the chain synchronously — before the envelope gate, the
      // traveler sheet, auth, refresh and POST. A second tap, or any edit
      // control, is refused until the finally below releases it.
      saveChainActive = true;
      setReason('', false);   // a new tap starts with a clean reason line
      render();
      try {
        // Unresolved-envelope gate (shipped protection, layered, not replaced).
        if (await app.unresolvedEnvelopeBlocks()) return;
        const elig = saveEligibility();
        if (!elig.ok && elig.reason !== COPY.saveBusy) return;

        refreshUsedThisTap = false;
        resubmitUsedThisTap = false;

        // Traveler confirmation is value-bound: only a CHANGED traveler whose
        // key differs from the confirmed key reopens the sheet. The sheet is
        // the one surface that stays operable while the chain is claimed.
        const cmp = comparison();
        if (cmp.changed.includes('traveler')) {
          const key = model.travelerKey(draft.traveler, draft.booker);
          if (travelerConfirmedKey !== key) {
            await new Promise((resolve) => openTravelerSheet('confirm', () => resolve()));
            // An external close (lifecycle handoff, CAS rehydration, Discard)
            // settles the sheet as cancelled and tears the session down; the
            // continuation must then simply end.
            if (gen !== generation || !draft) return;
            if (travelerConfirmedKey !== model.travelerKey(draft.traveler, draft.booker)) {
              return;   // changed inside confirmation, or backed out → new tap
            }
          }
        }
        await attemptSave();
      } finally {
        saveChainActive = false;
        if (ui) render();
      }
    }

    async function attemptSave() {
      submitInFlight = true;
      const gen = generation;
      render();
      try {
        // Eligibility was checked at the tap and the chain has been claimed
        // since, so nothing could have changed underneath. Re-check anyway:
        // the traveler sheet may have moved the draft.
        const elig = saveEligibility();
        if (!elig.ok && elig.reason !== COPY.saveBusy) return;

        // Expired-but-complete → ONE quiet refresh, bound to this tap.
        if (!heldIsFresh()) {
          if (refreshUsedThisTap) { setReason(COPY.priceChanged, true); return; }
          refreshUsedThisTap = true;
          const refreshAttempt = freezeAttempt();
          const ok = await requestQuote({ force: true });
          if (gen !== generation) return;
          if (!ok) return;
          const after = freezeAttempt();
          if (!after || !refreshAttempt ||
              after.intentKey !== refreshAttempt.intentKey ||
              after.travelerKey !== refreshAttempt.travelerKey ||
              after.vehicleKey !== refreshAttempt.vehicleKey) {
            setReason(COPY.priceChanged, true);
            return;
          }
          if (after.finalCents !== refreshAttempt.finalCents) {
            setReason(COPY.priceChanged, true);
            return;
          }
        }

        const commit = freezeAttempt();
        if (!commit) return;
        await postAttempt(commit, gen);
      } finally {
        submitInFlight = false;
        if (gen === generation) render();
      }
    }

    // Every submitted byte comes from here: the frozen draft + the held
    // quote for its exact intent, captured together.
    function freezeAttempt() {
      if (!heldIsCurrent()) return null;
      const a = adapter();
      if (!a) return null;
      const v = held.data.vehicles[draft.vehicle.key];
      if (!v || !v.ok) return null;
      const projection = a.projectRoute(draft.route);
      const routeIntent = a.toQuoteIntent(draft.route);
      if (!routeIntent) return null;
      const card = resolvedCardVehicle(draft.vehicle.key);
      if (!card) return null;
      const vehicleChanged = draft.vehicle.key !== snapshot.vehicle.key;
      const account = accountIdentity() || {};
      const travelerKey = model.travelerKey(draft.traveler, draft.booker);
      // EVERYTHING the payload needs is captured here, at freeze time, so
      // buildPayload is a pure function of the attempt: no live account,
      // snapshot or context read can drift underneath an await.
      const attempt = {
        bookingId: ctx.bookingId,
        tripCode: ctx.tripCode || '',
        intentKey: intentKey(draftIntent()),
        travelerKey,
        travelerChanged: travelerKey !== model.travelerKey(snapshot.traveler, snapshot.booker),
        accountPhone: normText(account.phone),
        vehicleKey: draft.vehicle.key,
        vehicleName: card.name,
        bags: vehicleChanged ? card.bagCapacity : snapshot.bags,
        finalCents: v.finalCents,
        token: v.token,
        pricingVersion: held.data.pricingVersion,
        routeMilesTenths: held.data.route.milesTenths,
        routeMinutes: held.data.route.minutes,
        // The route-write projection is a deep clone of the ADAPTER's quote
        // projection of the draft route — which already carries the canonical
        // identity, because adoption wrote it onto the draft when the quote
        // landed. The server's intent echo is NEVER merged into a write: it
        // carries response-only fields (formattedAddress, airportName,
        // pickupAt, passengers) and, spread, could override write authority.
        // Spread downstream, never enumerated — the card still names none of
        // these fields.
        routeWrite: model.deepClone(routeIntent),
        originLabel: projection.origin.label,
        destinationLabel: projection.destination.label,
        pickupAt: new Date(Date.parse(draft.pickupAt)).toISOString(),
        passengers: draft.passengers,
        traveler: model.deepClone(draft.traveler),
        booker: draft.booker ? model.deepClone(draft.booker) : null,
        snapshotBooker: snapshot.booker ? model.deepClone(snapshot.booker) : null,
        detailsVersion: snapshot.detailsVersion
      };
      return model.deepFreeze(model.deepClone(attempt));
    }

    // The writer's booker rule (018:1094-1096): its ONLY clearing path is a
    // submitted booker name EQUAL to the customer name; null preserves.
    function buildPayload(attempt, operationId) {
      // PURE: reads the frozen attempt and the operation id, nothing else.
      const travelerChanged = attempt.travelerChanged;
      let bookerName = null;
      let bookerPhone = null;
      if (!travelerChanged) {
        bookerName = attempt.snapshotBooker ? attempt.snapshotBooker.name : null;
        bookerPhone = attempt.snapshotBooker ? attempt.snapshotBooker.phone : null;
      } else if (attempt.booker) {
        bookerName = attempt.booker.name;
        bookerPhone = attempt.booker.phone;
      } else {
        // guest→self: clear by submitting the booker name EQUAL to the new
        // customer name; a null would preserve the old booker.
        bookerName = attempt.traveler.name;
        bookerPhone = attempt.accountPhone || attempt.traveler.phone;
      }
      // Spread order is a safety boundary: the adapter's route projection
      // goes FIRST, so every client-owned/core field below wins over it.
      const payload = {
        ...attempt.routeWrite,
        operationId,
        bookingId: attempt.bookingId,
        expectedDetailsVersion: attempt.detailsVersion,
        tripId: attempt.tripCode,
        customerName: attempt.traveler.name,
        phone: attempt.traveler.phone,
        bookerName,
        bookerPhone,
        pickup: attempt.originLabel,
        dropoff: attempt.destinationLabel,
        dateTime: attempt.pickupAt,
        vehicle: attempt.vehicleName,
        price: attempt.finalCents / 100,
        passengers: attempt.passengers,
        bags: attempt.bags,
        quoteToken: attempt.token,
        vehicleKey: attempt.vehicleKey,
        routeMilesTenths: attempt.routeMilesTenths,
        routeMinutes: attempt.routeMinutes,
        pricingVersion: attempt.pricingVersion
      };
      // email: nonblank is sent; blank omitted (only legal when the snapshot
      // email is null — the gate enforced that).
      if (normText(attempt.traveler.email)) payload.email = attempt.traveler.email;
      // NOT sent, by contract: paymentMethod, promoCode, flightNumber
      // (preserved server-side), notes, pickupSign (read-only, decision 13).
      return payload;
    }

    async function postAttempt(commit, gen) {
      const session = await getSession();
      if (gen !== generation) return;
      if (!session || !session.access_token) { setReason(COPY.notSaved, true); return; }
      const operationId = (randomUUID && randomUUID()) || app.newOperationId();
      const payload = buildPayload(commit, operationId);
      const envelope = {
        operationId,
        bodyString: JSON.stringify(payload),
        kind: 'edit',
        bookingId: ctx.bookingId,
        authSubject: (session.user && session.user.id) || null,
        createdAt: now()
      };
      if (!app.storePendingEnvelope(envelope)) { setReason(COPY.notSaved, true); return; }
      const out = await app.submitEnvelope('/api/update-pending-booking', envelope.bodyString,
        session.access_token, 'edit');
      if (gen !== generation) return;
      if (!out.definitive) {
        app.offerPendingEnvelope(envelope.authSubject);
        setReason('We couldn’t confirm the result — use Check again. Nothing needs to be re-entered.', true);
        return;
      }
      app.clearPendingEnvelope(operationId);
      const { response, result } = out;

      if (response.status === 428 && result && result.reload === true) { app.reloadOutdated(); return; }

      if (result && result.requote === true) {
        if (!resubmitUsedThisTap && !refreshUsedThisTap) {
          resubmitUsedThisTap = true;
          refreshUsedThisTap = true;
          const before = freezeAttempt();
          const ok = await requestQuote({ force: true });
          if (gen !== generation || !ok) return;
          const after = freezeAttempt();
          if (after && before && after.intentKey === before.intentKey &&
              after.travelerKey === before.travelerKey && after.vehicleKey === before.vehicleKey &&
              after.finalCents === before.finalCents) {
            await postAttempt(after, gen);
            return;
          }
        }
        if (held) held.expiresAt = 0;
        setReason(COPY.priceChanged, true);
        return;
      }

      if (response.status === 400 && result && result.error === 'pickup_time_elapsed') {
        markElapsed();
        return;
      }
      if (response.status === 401) { setReason('Your session expired — please sign in again.', true); return; }
      if (response.status === 403) { setReason('You do not have permission to edit this ride.', true); return; }
      if (response.status === 409) {
        // v8.6: HTTP 409 alone never chooses the experience. Only the EXACT
        // typed not-editable shape is a lifecycle change; the typed version
        // shape is a CAS conflict; every other 409 — including the writer's
        // untyped `{error:'Could not process this request'}` — preserves the
        // card and the draft and says plainly that nothing was saved.
        const err = result && typeof result.error === 'string' ? result.error : '';
        const typedNotEditable = err === 'Ride is no longer editable' || err === 'not_editable';
        const typedVersion = Number.isInteger(result && result.currentDetailsVersion) &&
          (result.currentStatus === undefined || result.currentStatus === 'pending');
        if (typedNotEditable) { lifecycleHandoff(result.currentStatus || null); return; }
        if (typedVersion) { await casConflict(); return; }
        setReason(COPY.notSaved, true);
        return;
      }
      if (!response.ok || !result || !result.bookingId) { setReason(COPY.notSaved, true); return; }

      // Success: the server's version becomes the truth; the card closes and
      // the trip sheet re-reads authoritative status.
      const bookingId = ctx.bookingId;
      const tripCode = result.tripId || ctx.tripCode;
      close();
      app.editSaved({ bookingId, tripCode, detailsVersion: result.detailsVersion });
    }

    // ---- render ------------------------------------------------------------
    function setReason(text, sticky) {
      if (!ui) return;
      ui.reason.textContent = text || '';
      if (sticky) ui.reason.dataset.sticky = '1'; else delete ui.reason.dataset.sticky;
    }

    function render() {
      if (!ui || !draft) return;
      const a = adapter();
      const cmp = comparison();

      ui.title.textContent = `Manage ride ${ctx.tripCode || ''}`.trim();

      // route — the adapter's projection only. A route with no quotable
      // intent (every legacy row) is shown "as booked" until a fresh
      // selection converts it.
      const p = a ? a.projectRoute(draft.route) : null;
      const quotable = !!(a && a.toQuoteIntent(draft.route));
      if (p) {
        ui.routeText.textContent = quotable
          ? `${p.origin.label} → ${p.destination.label}`
          : `Current (as booked): ${p.origin.label} → ${p.destination.label}`;
      }
      clear(ui.routeAttribution);
      const attributions = p ? [...(p.origin.attributions || []), ...(p.destination.attributions || [])] : [];
      ui.routeAttribution.appendChild(renderAttribution(doc, attributions));

      // time
      ui.timeText.textContent = timeResolution === 'resolved'
        ? `Pickup: ${model.formatMiami(draft.pickupAt)}`
        : 'Pickup: choose a time';

      // vehicle
      const current = resolvedCardVehicle(draft.vehicle.key);
      const label = current ? current.name : draft.vehicle.name;
      const changedVehicle = cmp.changed.includes('vehicle');
      const sel = selectedVehicleEntry();
      if (!cmp.changed.length || !sel) {
        ui.vehicleText.textContent = `${label} · Current ride ${money(snapshot.bookedPriceCents)}`;
      } else {
        ui.vehicleText.textContent = `${label} · Updated total ${money(sel.finalCents)}`;
      }
      ui.vehicleToggle.textContent = vehiclesOpen ? 'Hide options' : 'Change vehicle';
      renderVehicleOptions(cmp);

      // passengers
      ui.paxText.textContent = draft.passengers === snapshot.passengers
        ? `Booked passenger count: ${draft.passengers}`
        : `Passengers: ${draft.passengers} (booked: ${snapshot.passengers})`;
      ui.paxValue.textContent = String(draft.passengers);
      const max = fleetMaxPassengers();

      // traveler
      const t = draft.traveler || {};
      ui.travelerText.textContent = draft.booker
        ? `Traveler: ${t.name || ''} · Booked by ${draft.booker.name || ''}`
        : `Traveler: ${t.name || ''}`;

      // notes / sign — read-only
      const notes = snapshot.optional && snapshot.optional.notes;
      const sign = snapshot.optional && snapshot.optional.pickupSign;
      ui.notesLine.textContent = notes ? `Notes for your driver: ${notes}` : '';
      ui.notesLine.hidden = !notes;
      ui.signLine.textContent = sign ? `Pickup sign: ${sign}` : '';
      ui.signLine.hidden = !sign;

      // before → after
      clear(ui.changes);
      for (const field of cmp.changed) {
        const line = el(doc, 'div', 'pe-change-line');
        line.textContent = beforeAfter(field, sel);
        ui.changes.appendChild(line);
      }

      // whole-quote status
      ui.status.textContent = '';
      ui.status.hidden = true;
      if (quoteState === 'loading') { ui.status.textContent = COPY.gettingPrices; ui.status.hidden = false; }
      else if (quoteState === 'error') {
        ui.status.textContent = quoteError && quoteError.code === 'incomplete' ? COPY.quoteUnavailable : COPY.quoteFailed;
        ui.status.hidden = false;
        clear(ui.status);
        ui.status.appendChild(doc.createTextNode(quoteError && quoteError.code === 'incomplete' ? COPY.quoteUnavailable : COPY.quoteFailed));
        if (quoteError && quoteError.retryable) {
          const b = el(doc, 'button', 'pe-retry', 'Try again');
          b.type = 'button';
          b.addEventListener('click', () => requestQuote({ force: true }));
          ui.status.appendChild(b);
        }
      }

      // save + reason
      const elig = saveEligibility();
      ui.save.disabled = !elig.ok || chainBusy();
      ui.save.textContent = chainBusy() ? COPY.saveBusy : (elig.ok && elig.stale ? COPY.saveRefresh : COPY.saveIdle);
      // A sticky reason ("The price changed — review it and tap Save again")
      // survives until an EVENT clears it — a new tap, a valid pick, open —
      // never a render, or the review note would vanish under the reader.
      if (!ui.reason.dataset.sticky) ui.reason.textContent = elig.ok ? '' : elig.reason;
      const busy = chainBusy();
      ui.routeChange.disabled = busy;
      ui.vehicleToggle.disabled = busy;
      ui.travelerEdit.disabled = busy;
      ui.discard.disabled = busy;
      ui.dateInput.disabled = busy;
      ui.timeInput.disabled = busy;
      ui.paxEdit.disabled = busy;
      ui.paxMinus.disabled = busy || draft.passengers <= 1;
      ui.paxPlus.disabled = busy || draft.passengers >= max;
      for (const b of ui.timeChoice.children || []) if (b && 'disabled' in b) b.disabled = busy;
      for (const r of ui.vehicleOptions.children || []) if (r && 'disabled' in r) r.disabled = busy || r.disabled;
    }

    function beforeAfter(field, sel) {
      const sa = model.adapterFor(snapshot.route.kind);
      const da = adapter();
      switch (field) {
        case 'route': {
          const b = sa ? sa.projectRoute(snapshot.route) : null;
          const af = da ? da.projectRoute(draft.route) : null;
          return `Route: ${b ? `${b.origin.label} → ${b.destination.label}` : ''} → ${af ? `${af.origin.label} → ${af.destination.label}` : ''}`;
        }
        case 'pickupAt':
          if (timeResolution !== 'resolved') return 'Pickup time: choose a time';
          return `Pickup time: ${model.formatMiami(snapshot.pickupAt)} → ${model.formatMiami(draft.pickupAt)}`;
        case 'passengers':
          return `Passengers: ${snapshot.passengers} → ${draft.passengers}`;
        case 'vehicle': {
          const before = resolvedCardVehicle(snapshot.vehicle.key);
          const after = resolvedCardVehicle(draft.vehicle.key);
          return `Vehicle: ${before ? before.name : snapshot.vehicle.name} → ${after ? after.name : draft.vehicle.name}` +
            (sel ? ` (${money(sel.finalCents)})` : '');
        }
        case 'traveler':
          return `Traveler: ${(snapshot.traveler && snapshot.traveler.name) || ''} → ${(draft.traveler && draft.traveler.name) || ''}`;
        default:
          return '';
      }
    }

    function renderVehicleOptions(cmp) {
      clear(ui.vehicleOptions);
      ui.vehicleOptions.hidden = !vehiclesOpen;
      if (!vehiclesOpen) return;
      const fresh = heldIsFresh();
      const current = heldIsCurrent();
      for (const v of snapshot.vehicles || []) {
        const row = el(doc, 'button', 'pe-vehicle-option');
        row.type = 'button';
        row.setAttribute('role', 'radio');
        row.setAttribute('aria-checked', v.key === draft.vehicle.key ? 'true' : 'false');
        const entry = current ? held.data.vehicles[v.key] : null;
        let price = '';
        if (!cmp.isComplete) price = COPY.reselect;
        else if (quoteState === 'loading') price = '…';
        else if (entry && entry.ok) price = fresh ? money(entry.finalCents) : `${money(entry.finalCents)} · Expired`;
        else if (entry && !entry.ok) price = 'Unavailable';
        const name = el(doc, 'div', 'pe-vo-name', v.name);
        const cap = el(doc, 'div', 'pe-vo-cap',
          `Up to ${v.passengerCapacity} passengers · approx. ${v.bagCapacity} standard bags`);
        const pr = el(doc, 'div', 'pe-vo-price', price);
        row.appendChild(name); row.appendChild(cap); row.appendChild(pr);
        row.disabled = !!(entry && !entry.ok);
        row.addEventListener('click', () => chooseVehicle(v.key));
        ui.vehicleOptions.appendChild(row);
      }
    }

    // ---- public surface ----------------------------------------------------
    return {
      open,
      close,
      isOpen: () => !!mount,
      quoteSurfaceActive,
      // test/introspection hooks — read-only views
      _draft: () => draft,
      _snapshot: () => snapshot,
      _held: () => held,
      _freezeAttempt: freezeAttempt,
      _buildPayload: buildPayload,
      _eligibility: saveEligibility,
      _executeComparator: executeComparator,
      _timeResolution: () => timeResolution,
      _chainBusy: chainBusy,
      _sheetOpen: () => !!sheet,
      _ui: () => ui,
      COPY
    };
  }

  return { createPendingEditCard, COPY };
}));
