// Shared per-event notification dispatcher — extracted VERBATIM from the
// watchdog (PR 3A) so the scheduled loop and the future cancellation
// endpoint use ONE trusted executor. Lives in lib/ (no index.js) so
// Netlify never deploys it as its own endpoint; esbuild bundles it.
//
// NOTHING behavioral changed in the extraction. The frozen semantics —
// routing precedence over delivery history, claim-by-insert arbitration,
// per-channel attempt caps, ambiguity-is-terminal-never-resent,
// definitive-push -> Telegram-fallback ordering, finalization-failure
// stops, and the global provider-call ceiling — are exactly the
// watchdog's, and tests/notification-ledger.test.js continues to pin
// them end-to-end through the watchdog while tests/dispatch-module.test.js
// proves them directly against this module.
//
// The ONLY interface change from the in-watchdog originals: callers pass
// an options object { summary, dbFail, maxAttempts } which is VALIDATED
// UP FRONT — a missing or malformed configuration throws loudly instead
// of silently removing the provider-call ceiling. Only dispatchOne is
// exported; the channel executors stay private so no caller can bypass
// their write ordering.

const notify = require('./notify');

// Dispatch refetches ONE row and may render cancellation templates, which
// read the stamped shadow-fee audit (migration 013) — the notification
// claims DB truth, never a recomputation. Sweeps stay lean on their own
// field lists; only the per-event refetch pays for the extra columns.
const DISPATCH_FIELDS = 'id, trip_id, status, pickup_datetime, pickup_location, ' +
  'dropoff_location, customer_name, assigned_driver, driver_ready_at, ' +
  'driver_ready_by, driver_ready_source, at_risk_at, accepted_at' +
  ', price, cancelled_at, cancelled_from_status, ' +
  'cancel_fee_percent, cancel_fee_policy_amount, cancel_fee_collected, cancel_waiver_reason';

// Dispatch one due event: refetch the live booking, re-check relevance,
// transition to in_delivery (a LOST CAS means another process changed the
// event — stop without sending), claim by insert, send, finalize, roll
// the event up. 'submitted' is the terminal success — provider acceptance
// is NOT proof anyone saw it. Every real DB failure is surfaced via
// dbFail; a failure never guesses an event outcome.
async function dispatchOne(db, ev, nowMs, opts) {
  // Options are validated BEFORE any read, write, or provider call: a
  // caller that cannot state its ceiling must not dispatch at all.
  if (!opts || typeof opts !== 'object') {
    throw new Error('dispatchOne: options object required');
  }
  const { summary, dbFail, maxAttempts } = opts;
  if (!summary || typeof summary !== 'object' ||
      !Number.isInteger(summary.attempts) || summary.attempts < 0 ||
      !Number.isInteger(summary.submitted) || summary.submitted < 0) {
    throw new Error('dispatchOne: summary attempts/submitted must be non-negative integers');
  }
  if (typeof dbFail !== 'function') {
    throw new Error('dispatchOne: dbFail callback required');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('dispatchOne: maxAttempts must be a positive integer');
  }

  const nowIso = new Date(nowMs).toISOString();
  const suppress = async (reason) => {
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'suppressed', suppress_reason: reason });
    if (error) dbFail(`suppress ${reason}`, error);
  };

  const { data: b, error: refetchError } = await db.from('bookings')
    .select(DISPATCH_FIELDS).eq('id', ev.booking_id).maybeSingle();
  if (refetchError) {
    // Transient read failure must NOT condemn the event as missing.
    dbFail('dispatch refetch', refetchError);
    return;
  }
  if (!b) {
    await suppress('booking_missing');
    return;
  }

  // Staleness gates: not_after, then per-type relevance on the LIVE row.
  if (ev.not_after && nowMs > Date.parse(ev.not_after)) {
    await suppress('expired');
    return;
  }
  if (notify.CHAIN_TYPES.includes(ev.event_type)) {
    if (b.status !== 'confirmed' || notify.readinessValid(b)) {
      await suppress(b.status !== 'confirmed' ? 'driver_active' : 'driver_ready');
      return;
    }
    if (ev.recipient_role === 'driver' && ev.recipient_key !== b.assigned_driver) {
      await suppress('reassigned');
      return;
    }
  }
  // Cancellation events claim the row IS cancelled — same principle as
  // at_risk_mark deriving only from the stamped column. If the live row
  // says otherwise (however unlikely), the claim would be a lie: suppress.
  if (notify.CANCELLATION_TYPES.includes(ev.event_type) && b.status !== 'cancelled') {
    await suppress('not_cancelled');
    return;
  }

  // Absolute escalation deadline (driver ask events): a reminder whose
  // deadline has passed is stale on EVERY channel — suppress it with
  // zero provider calls. (Chain collapse usually handles this by
  // superseding; this is the defense when the later member isn't
  // pending, e.g. it already ran.)
  const deadlineMin = notify.ASK_DEADLINE_MIN[ev.event_type];
  if (deadlineMin) {
    const pickupMs = Date.parse(b.pickup_datetime);
    if (Number.isFinite(pickupMs) && nowMs >= pickupMs - deadlineMin * 60e3) {
      await suppress('stale_deadline');
      return;
    }
  }

  // Channel routing. Admin events are Telegram-only, always. Driver
  // events follow the STRICT precedence over delivery history (routing
  // is restart-safe: a crash between a failed push and its fallback is
  // healed here on the next cycle from stored truth).
  let route;
  if (ev.recipient_role !== 'driver') {
    route = { channel: 'telegram' };
  } else {
    route = await notify.resolveDriverRoute(db, ev, b.assigned_driver);
    if (route.dbError) {
      dbFail('route resolution', route.dbError);
      return;
    }
    if (route.done) {
      const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
        { state: route.done });
      if (error) dbFail('rollup routed', error);
      return;
    }
  }

  const marked = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
    { state: 'in_delivery' });
  if (marked.error) {
    // Can't record state -> don't send: an unrecorded send could duplicate.
    dbFail('mark in_delivery', marked.error);
    return;
  }
  if (!marked.row) {
    // LOST CAS: between the relevance check and this transition, another
    // process suppressed or terminally changed the event. Its decision
    // stands — sending now would be a stale notification. Stop here:
    // no delivery row, no provider call.
    return;
  }

  if (route.channel === 'webpush') {
    await executeWebPush(db, ev, b, route.sub, nowMs, summary, dbFail, suppress, maxAttempts);
  } else {
    await executeTelegram(db, ev, b, nowMs, summary, dbFail, suppress, maxAttempts);
  }
}

// Telegram execution for one event (normal route AND push-fallback):
// claim by insert, send, finalize, roll up. Self-checks the global
// provider-call cap because a fallback send is a SECOND call in one
// dispatch. PRIVATE: only dispatchOne may invoke it, preserving the
// gate-then-claim ordering.
async function executeTelegram(db, ev, b, nowMs, summary, dbFail, suppress, maxAttempts) {
  const nowIso = new Date(nowMs).toISOString();
  if (!process.env.TELEGRAM_BOT_TOKEN) return; // config gap: leave for next cycle

  const chatId = ev.recipient_role === 'driver'
    ? await notify.resolveDriverChatId(db, b.assigned_driver, dbFail)
    : process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!chatId) return; // config gap, not a send failure — leave for next cycle

  const text = notify.renderEvent(ev.event_type, b);
  if (!text) {
    await suppress('no_template');
    return;
  }

  // GLOBAL CAP FIRST — before any delivery row exists. A claim created
  // and then never sent would age into ambiguous next cycle and wrongly
  // terminate the event; with no row, the next cycle simply sends.
  if (summary.attempts >= maxAttempts) return;

  const claim = await notify.createDelivery(db, ev, 'telegram', chatId);
  if (claim.dbError) {
    dbFail('createDelivery telegram', claim.dbError);
    return;
  }
  if (claim.satisfied) {
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'submitted' });
    if (error) dbFail('rollup satisfied', error);
    return;
  }
  if (claim.lost || claim.inFlight) return; // another worker owns it
  if (claim.blocked || claim.capped) {
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup exhausted', error);
    return;
  }

  summary.attempts++; // every provider call counts, success or not
  const result = await notify.sendTelegram(chatId, text);
  // Finalization failures STOP immediately in every branch: once the
  // delivery's recorded truth is unknown, no health stamp, rollup, or
  // any further write may run. The claimed row ages into ambiguous via
  // stale recovery (never a blind resend) and the run reports 500.
  let fin;
  if (result.outcome === 'submitted') {
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'submitted', submitted_at: nowIso });
    if (fin.error) {
      dbFail('finalize submitted', fin.error);
      return;
    }
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'submitted' });
    if (error) dbFail('rollup submitted', error);
    summary.submitted++;
  } else if (result.outcome === 'ambiguous') {
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'ambiguous', finalized_at: nowIso, last_error: result.error });
    if (fin.error) {
      dbFail('finalize ambiguous', fin.error);
      return;
    }
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup ambiguous', error);
  } else if (result.outcome === 'definitive') {
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso, last_error: result.error });
    if (fin.error) {
      dbFail('finalize definitive', fin.error);
      return;
    }
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup definitive', error);
  } else {
    // retryable: record the failure; the event stays in_delivery and the
    // next cycle creates attempt N+1 (cap enforced in createDelivery).
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso, last_error: result.error });
    if (fin.error) {
      dbFail('finalize retryable', fin.error);
      return;
    }
    if (claim.delivery.attempt_no >= notify.MAX_ATTEMPTS_PER_CHANNEL) {
      const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
        { state: 'exhausted' });
      if (error) dbFail('rollup attempt cap', error);
    }
  }
}

// Web Push execution for one driver event. On a DEFINITIVE failure the
// database-safe ordering is strict: (1) persist the failed delivery +
// failure_class; (2) for expired endpoints, disable the subscription;
// (3) claim and send the Telegram fallback. Any database failure in
// that sequence stops IMMEDIATELY (dbFail -> the caller's dbErrors gate
// ends the cycle) with no further provider call — the next cycle
// recovers from stored truth via the routing precedence. PRIVATE: only
// dispatchOne may invoke it.
async function executeWebPush(db, ev, b, sub, nowMs, summary, dbFail, suppress, maxAttempts) {
  const nowIso = new Date(nowMs).toISOString();

  // GLOBAL CAP FIRST — before any delivery row exists (see executeTelegram).
  if (summary.attempts >= maxAttempts) return;

  // target = subscription row UUID — NEVER the endpoint (secret).
  const claim = await notify.createDelivery(db, ev, 'webpush', sub.id);
  if (claim.dbError) {
    dbFail('createDelivery webpush', claim.dbError);
    return;
  }
  if (claim.satisfied) {
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'submitted' });
    if (error) dbFail('rollup satisfied', error);
    return;
  }
  if (claim.lost || claim.inFlight) return;
  if (claim.blocked || claim.capped) {
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup exhausted', error);
    return;
  }

  // Absolute TTL from the escalation deadline (deadline-passed events
  // were already suppressed before routing).
  const deadlineMin = notify.ASK_DEADLINE_MIN[ev.event_type];
  const pickupMs = Date.parse(b.pickup_datetime);
  const deadlineMs = (deadlineMin && Number.isFinite(pickupMs))
    ? pickupMs - deadlineMin * 60e3
    : (ev.not_after ? Date.parse(ev.not_after) : nowMs + 900e3);
  const ttl = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const topic = notify.readinessTopic(b);
  const payload = notify.pushPayloadFor(ev.event_type, b);

  summary.attempts++;
  const result = await notify.sendWebPush(sub, payload, { ttl, topic });
  // Finalization failures STOP immediately in every branch (same rule as
  // executeTelegram): unknown recorded truth means no health stamp, no
  // rollup, no fallback — the run reports 500 and the next cycle
  // recovers from stored truth.

  if (result.outcome === 'submitted') {
    const fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'submitted', submitted_at: nowIso });
    if (fin.error) {
      dbFail('finalize push submitted', fin.error);
      return;
    }
    // Health info only (never used for device selection).
    const { error: healthError } = await db.from('push_subscriptions')
      .update({ last_success_at: nowIso })
      .eq('id', sub.id)
      .select();
    if (healthError) {
      dbFail('push health stamp', healthError);
      return; // rule 1 of the routing precedence rolls the event up next cycle
    }
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'submitted' });
    if (error) dbFail('rollup push submitted', error);
    summary.submitted++;
    return;
  }

  if (result.outcome === 'ambiguous') {
    // May have transmitted: terminal, never resent, NO fallback — a
    // second channel would risk exactly the duplicate the ledger forbids.
    const fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'ambiguous', finalized_at: nowIso,
        failure_class: 'ambiguous', last_error: result.error });
    if (fin.error) {
      dbFail('finalize push ambiguous', fin.error);
      return;
    }
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup push ambiguous', error);
    return;
  }

  if (result.outcome === 'retryable') {
    const fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso,
        failure_class: result.failureClass, last_error: result.error });
    if (fin.error) {
      dbFail('finalize push retryable', fin.error);
      return;
    }
    if (claim.delivery.attempt_no >= notify.MAX_ATTEMPTS_PER_CHANNEL) {
      const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
        { state: 'exhausted' });
      if (error) dbFail('rollup push attempt cap', error);
    }
    return;
  }

  // DEFINITIVE — database-safe fallback ordering (strict):
  // (1) persist the failed delivery with its class. Failure -> STOP.
  const fin = await notify.finalizeDelivery(db, claim.delivery.id,
    { state: 'failed', finalized_at: nowIso,
      failure_class: result.failureClass, last_error: result.error });
  if (fin.error) {
    dbFail('finalize push definitive', fin.error);
    return;
  }
  // (2) 404/410 ONLY: disable the subscription. Failure -> STOP.
  if (result.failureClass === 'expired_endpoint') {
    const { error: disableError } = await db.from('push_subscriptions')
      .update({ disabled_at: nowIso, disabled_reason: 'expired', last_error: result.error })
      .eq('id', sub.id)
      .select();
    if (disableError) {
      dbFail('disable expired subscription', disableError);
      return;
    }
  }
  if (result.failureClass === 'vapid_config') {
    // OUR configuration failing — subscription KEPT; sanitized loud log.
    console.error(`❌ Web Push VAPID configuration rejected (${result.error}) — check VAPID_* env; falling back to Telegram`);
  }
  // (3) claim and send the Telegram fallback (its own cap self-check).
  await executeTelegram(db, ev, b, nowMs, summary, dbFail, suppress, maxAttempts);
}

// Only the orchestrating entry point is public. The channel executors
// stay private so no future caller can bypass the gate-then-claim
// ordering or the definitive-fallback sequence.
module.exports = { dispatchOne };
