// Proactive readiness watchdog — Netlify Scheduled Function (PR 1).
// Declared in netlify.toml:  [functions."notification-watchdog"]
//                            schedule = "*/5 * * * *"
//
// Runs ONLY on published production deploys and is not exposed as a URL
// endpoint. Documented platform limit is 30 s; this handler keeps an 8 s
// soft budget with hard caps (50 bookings, 15 dispatches) so invocations
// stay boring. Kill switch: WATCHDOG_DISABLED=1.
//
// One invocation (see the implementation plan §8):
//   B. SWEEP      one bounded bookings query
//   A. HEARTBEAT  ride-day-only admin summary (system_state-guarded)
//   C. AT-RISK    stamp bookings.at_risk_at at T-105 — a conditional
//                 UPDATE that is INDEPENDENT of Telegram delivery.
//                 Telegram is the alert channel; the DB is the truth.
//   D. DERIVE     idempotent event inserts (unique identity arbitrates)
//   E. SUPPRESS   moot chains (ready / advanced / reassigned) + collapse
//   F. RECOVER    expired claims -> ambiguous (uniform, every channel)
//   G. DISPATCH   claim-by-insert, send Telegram, roll events up
//
// Every step is an ON CONFLICT insert, a conditional UPDATE, or a
// unique-arbitrated row creation — overlapping invocations degrade to
// wasted work, never duplicate sends. No exactly-once from the platform
// is assumed.
//
// PR 1 scope: readiness chain only, Telegram only. Push (PR 2), routes
// and completion-overdue (PR 3), passenger SMS (PR 4) plug into the same
// ledger without changing this loop's shape.

const { createClient } = require('@supabase/supabase-js');
const notify = require('./lib/notify');

const SWEEP_FIELDS = 'id, trip_id, status, pickup_datetime, pickup_location, ' +
  'dropoff_location, customer_name, assigned_driver, driver_ready_at, ' +
  'driver_ready_by, driver_ready_source, at_risk_at, accepted_at';

const SOFT_BUDGET_MS = 8000;
const MAX_BOOKINGS = 50;
const MAX_DISPATCHES = 15;
const AT_RISK_OFFSET_MS = 105 * 60 * 1000;

exports.handler = async () => {
  const summary = {
    swept: 0, atRisk: 0, derived: 0, suppressed: 0,
    recovered: 0, dispatched: 0, heartbeat: false
  };

  if (process.env.WATCHDOG_DISABLED === '1' || process.env.WATCHDOG_DISABLED === 'true') {
    console.log('⏸ Watchdog disabled via WATCHDOG_DISABLED');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('❌ Watchdog: missing Supabase configuration');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);

  const startMs = Date.now();
  const nowMs = startMs;
  const nowIso = new Date(nowMs).toISOString();

  try {
    // ---- B. SWEEP: one bounded query over upcoming/active rides ----
    const low = new Date(nowMs - 6 * 3600e3).toISOString();
    const high = new Date(nowMs + 3 * 3600e3).toISOString();
    const { data: sweptRows, error: sweepError } = await db
      .from('bookings')
      .select(SWEEP_FIELDS)
      .or(`and(status.in.(pending,confirmed),pickup_datetime.gte.${low},pickup_datetime.lte.${high}),status.in.(on_the_way,arrived,in_progress)`)
      .limit(MAX_BOOKINGS);
    if (sweepError) {
      console.error('❌ Watchdog sweep failed:', sweepError);
      return { statusCode: 500, body: JSON.stringify({ error: 'Sweep failed' }) };
    }
    const bookings = sweptRows || [];
    summary.swept = bookings.length;

    // ---- A. HEARTBEAT: ride days only, once per ET day ----
    // Silence on a quiet day means nothing; silence on a ride day is the
    // alarm. Guarded by a system_state CAS so overlapping invocations
    // send at most one summary.
    summary.heartbeat = await maybeHeartbeat(db, nowMs);

    // ---- C. OPERATIONAL STATE FIRST: at-risk stamp at T-105 ----
    // Recorded via its own conditional UPDATE, before and independent of
    // any Telegram delivery outcome.
    for (const b of bookings) {
      if (b.status !== 'confirmed' || notify.readinessValid(b)) continue;
      const pickupMs = Date.parse(b.pickup_datetime);
      if (!Number.isFinite(pickupMs)) continue;
      if (nowMs >= pickupMs - AT_RISK_OFFSET_MS && nowMs < pickupMs && !b.at_risk_at) {
        const { data } = await db.from('bookings')
          .update({ at_risk_at: nowIso })
          .eq('id', b.id).eq('status', 'confirmed').is('at_risk_at', null)
          .select();
        if (data && data.length) {
          b.at_risk_at = nowIso;
          summary.atRisk++;
        }
      }
    }

    // ---- D. DERIVE + IDEMPOTENT INSERT (UTC instant arithmetic) ----
    const eventRows = [];
    for (const b of bookings) {
      if (b.status !== 'confirmed' || !b.assigned_driver) continue;
      if (notify.readinessValid(b)) continue;
      const pickupMs = Date.parse(b.pickup_datetime);
      if (!Number.isFinite(pickupMs)) continue;
      for (const spec of notify.READINESS_CHAIN) {
        const dueMs = pickupMs - spec.offsetMin * 60e3;
        if (nowMs >= dueMs && nowMs < pickupMs) {
          eventRows.push({
            booking_id: b.id,
            event_type: spec.type,
            recipient_role: spec.role,
            recipient_key: spec.role === 'driver' ? b.assigned_driver : 'admin',
            state: 'pending',
            due_at: new Date(dueMs).toISOString(),
            not_after: new Date(pickupMs).toISOString()
          });
        }
      }
    }
    if (eventRows.length) {
      const { data: inserted } = await db.from('notification_events')
        .upsert(eventRows, {
          onConflict: 'booking_id,event_type,recipient_key',
          ignoreDuplicates: true
        })
        .select();
      summary.derived = (inserted || []).length;
    }

    // ---- E. SUPPRESSION: moot chains + reassigned recipients ----
    for (const b of bookings) {
      if (b.status === 'confirmed' && notify.readinessValid(b)) {
        summary.suppressed += await notify.suppressEvents(
          db, b.id, notify.CHAIN_TYPES, 'driver_ready');
      } else if (['on_the_way', 'arrived', 'in_progress'].includes(b.status)) {
        // On my way is the strongest possible readiness signal
        summary.suppressed += await notify.suppressEvents(
          db, b.id, notify.CHAIN_TYPES, 'driver_active');
      }
      if (b.assigned_driver) {
        // Recipient-keyed identity: a replacement driver gets their OWN
        // events; the old driver's pending rows are retired here.
        const { data: stale } = await db.from('notification_events')
          .update({ state: 'suppressed', suppress_reason: 'reassigned' })
          .eq('booking_id', b.id)
          .eq('recipient_role', 'driver')
          .neq('recipient_key', b.assigned_driver)
          .in('state', ['pending'])
          .select();
        summary.suppressed += (stale || []).length;
      }
    }

    // ---- F. RECOVER: expired claims -> ambiguous (every channel) ----
    // A worker that died mid-send is indistinguishable from a lost
    // response after transmission began — uniform terminal disposition,
    // never an automatic resend. Escalation events cover the gap.
    const staleIso = new Date(nowMs - notify.CLAIM_EXPIRY_MS).toISOString();
    const { data: expired } = await db.from('notification_deliveries')
      .update({ state: 'ambiguous', finalized_at: nowIso, last_error: 'claim expired' })
      .eq('state', 'claimed')
      .lt('claimed_at', staleIso)
      .select();
    summary.recovered = (expired || []).length;

    // ---- G. DISPATCH: due events -> claim-by-insert -> Telegram ----
    const { data: dueRows } = await db.from('notification_events')
      .select('*')
      .in('state', ['pending', 'in_delivery'])
      .lte('due_at', nowIso)
      .order('due_at', { ascending: true })
      .limit(30);
    let due = dueRows || [];

    // Chain collapse: several driver asks due at once (watchdog was down)
    // -> keep only the most urgent, suppress the rest as 'superseded'.
    const byBooking = new Map();
    for (const ev of due) {
      if (ev.state === 'pending' && notify.DRIVER_ASKS.includes(ev.event_type)) {
        if (!byBooking.has(ev.booking_id)) byBooking.set(ev.booking_id, []);
        byBooking.get(ev.booking_id).push(ev);
      }
    }
    const superseded = new Set();
    for (const asks of byBooking.values()) {
      if (asks.length < 2) continue;
      asks.sort((a, b) =>
        notify.DRIVER_ASKS.indexOf(a.event_type) - notify.DRIVER_ASKS.indexOf(b.event_type));
      for (const ev of asks.slice(0, -1)) {
        const done = await notify.setEventState(db, ev.id, ['pending'],
          { state: 'suppressed', suppress_reason: 'superseded' });
        if (done) {
          superseded.add(ev.id);
          summary.suppressed++;
        }
      }
    }
    due = due.filter((ev) => !superseded.has(ev.id));

    for (const ev of due) {
      if (summary.dispatched >= MAX_DISPATCHES) break;
      if (Date.now() - startMs > SOFT_BUDGET_MS) break;
      await dispatchOne(db, ev, nowMs, summary);
    }

    console.log('✅ Watchdog:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (error) {
    console.error('❌ Watchdog error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error', summary }) };
  }
};

// Ride-day heartbeat: at the first invocation of a new ET day that has
// upcoming (24 h) or active rides, send ONE admin summary. system_state
// CAS keeps it single even across overlapping invocations.
async function maybeHeartbeat(db, nowMs) {
  const adminChat = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!adminChat || !process.env.TELEGRAM_BOT_TOKEN) return false;

  const todayET = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: notify.MIAMI_TZ });
  const { data: row } = await db.from('system_state')
    .select('key, value').eq('key', 'last_heartbeat_date').maybeSingle();
  if (row && row.value === todayET) return false;

  const nowIso = new Date(nowMs).toISOString();
  const dayHigh = new Date(nowMs + 24 * 3600e3).toISOString();
  const { data: rideRows } = await db.from('bookings')
    .select('id')
    .or(`and(status.in.(pending,confirmed),pickup_datetime.gte.${nowIso},pickup_datetime.lte.${dayHigh}),status.in.(on_the_way,arrived,in_progress)`)
    .limit(50);
  const rideCount = (rideRows || []).length;
  if (!rideCount) return false; // quiet day: stay silent — silence stays meaningful

  let won = false;
  if (!row) {
    const { data: ins } = await db.from('system_state')
      .upsert([{ key: 'last_heartbeat_date', value: todayET }],
        { onConflict: 'key', ignoreDuplicates: true })
      .select();
    won = Boolean(ins && ins.length);
  } else {
    const { data: upd } = await db.from('system_state')
      .update({ value: todayET })
      .eq('key', 'last_heartbeat_date').eq('value', row.value)
      .select();
    won = Boolean(upd && upd.length);
  }
  if (!won) return false;

  await notify.sendTelegram(adminChat,
    `🟢 LinkMia watchdog: alive — ${rideCount} upcoming/active ride${rideCount === 1 ? '' : 's'} today.`);
  return true;
}

// Dispatch one due event: refetch the live booking, re-check relevance,
// claim by insert, send, finalize, roll the event up. 'submitted' is the
// terminal success for Telegram — provider acceptance is NEVER 'delivered'.
async function dispatchOne(db, ev, nowMs, summary) {
  const nowIso = new Date(nowMs).toISOString();

  const { data: b } = await db.from('bookings')
    .select(SWEEP_FIELDS).eq('id', ev.booking_id).single();
  if (!b) {
    await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'suppressed', suppress_reason: 'booking_missing' });
    return;
  }

  // Staleness gates: not_after, then per-type relevance on the LIVE row.
  if (ev.not_after && nowMs > Date.parse(ev.not_after)) {
    await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'suppressed', suppress_reason: 'expired' });
    return;
  }
  if (notify.CHAIN_TYPES.includes(ev.event_type)) {
    if (b.status !== 'confirmed' || notify.readinessValid(b)) {
      await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
        { state: 'suppressed', suppress_reason: b.status !== 'confirmed' ? 'driver_active' : 'driver_ready' });
      return;
    }
    if (ev.recipient_role === 'driver' && ev.recipient_key !== b.assigned_driver) {
      await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
        { state: 'suppressed', suppress_reason: 'reassigned' });
      return;
    }
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) return; // leave pending; next cycle may have config

  const chatId = ev.recipient_role === 'driver'
    ? await notify.resolveDriverChatId(db, b.assigned_driver)
    : process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!chatId) return; // leave pending — configuration gap, not a send failure

  const text = notify.renderEvent(ev.event_type, b);
  if (!text) {
    await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'suppressed', suppress_reason: 'no_template' });
    return;
  }

  await notify.setEventState(db, ev.id, ['pending', 'in_delivery'], { state: 'in_delivery' });

  const claim = await notify.createDelivery(db, ev, 'telegram', chatId);
  if (claim.satisfied) {
    await notify.setEventState(db, ev.id, ['pending', 'in_delivery'], { state: 'submitted' });
    return;
  }
  if (claim.lost || claim.inFlight) return; // another worker owns it
  if (claim.blocked || claim.capped) {
    // Ambiguous attempt (never resend) or attempt cap: nothing else can
    // satisfy this single-channel event — terminal, visible in the ledger.
    await notify.setEventState(db, ev.id, ['in_delivery'], { state: 'exhausted' });
    return;
  }

  const result = await notify.sendTelegram(chatId, text);
  if (result.outcome === 'submitted') {
    await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'submitted', submitted_at: nowIso });
    await notify.setEventState(db, ev.id, ['pending', 'in_delivery'], { state: 'submitted' });
    summary.dispatched++;
  } else if (result.outcome === 'ambiguous') {
    await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'ambiguous', finalized_at: nowIso, last_error: result.error });
    await notify.setEventState(db, ev.id, ['in_delivery'], { state: 'exhausted' });
  } else if (result.outcome === 'definitive') {
    await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso, last_error: result.error });
    await notify.setEventState(db, ev.id, ['in_delivery'], { state: 'exhausted' });
  } else {
    // retryable: record the failure; the event stays in_delivery and the
    // next cycle creates attempt N+1 (cap enforced in createDelivery).
    await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso, last_error: result.error });
    if (claim.delivery.attempt_no >= notify.MAX_ATTEMPTS_PER_CHANNEL) {
      await notify.setEventState(db, ev.id, ['in_delivery'], { state: 'exhausted' });
    }
  }
}
