// Proactive readiness watchdog — Netlify Scheduled Function (PR 1).
// Declared in netlify.toml:  [functions."notification-watchdog"]
//                            schedule = "*/5 * * * *"
//
// Runs ONLY on published production deploys and is not exposed as a URL
// endpoint. Documented platform limit is 30 s; this handler enforces an
// 8 s soft budget ACROSS EVERY PHASE (not just dispatch) with hard caps
// (50 bookings, 15 notification ATTEMPTS — failed and ambiguous sends
// consume time and provider calls exactly like successes, so the cap
// counts attempts, and successes are tracked separately as 'submitted').
// Kill switch: WATCHDOG_DISABLED=1. Budget override for tests:
// WATCHDOG_BUDGET_MS.
//
// One invocation:
//   B. SWEEP      one bounded bookings query, EARLIEST PICKUP FIRST so the
//                 row limit can never repeatedly starve imminent rides
//   A. HEARTBEAT  ride-day-only admin summary — claim/finalize state
//                 machine in system_state; the day is finalized ONLY after
//                 Telegram accepts the submission (see maybeHeartbeat)
//   C. AT-RISK    stamp bookings.at_risk_at at T-105 — a conditional
//                 UPDATE that is INDEPENDENT of Telegram delivery.
//                 Telegram is the alert channel; the DB is the truth.
//   D. DERIVE     idempotent event inserts (unique identity arbitrates)
//   E. SUPPRESS   moot chains (ready / advanced / reassigned), BATCHED —
//                 grouped updates, no per-booking query loops
//   F. RECOVER    expired claims -> ambiguous (uniform, never resent)
//   G. DISPATCH   claim-by-insert, send Telegram, roll events up
//
// Every step is an ON CONFLICT insert, a conditional UPDATE, or a
// unique-arbitrated row creation — overlapping invocations degrade to
// wasted work, never duplicate sends. No exactly-once from the platform
// is assumed.
//
// Database failures are never swallowed: only unique-violation 23505 is
// an expected outcome (a lost claim race). Every real failure increments
// summary.dbErrors, is logged with its site, and forces a 500 response —
// a watchdog run whose database work failed is NOT reported as clean.
//
// PR 1 scope: readiness chain only, Telegram only. Web Push (Driver PWA,
// then authenticated-passenger PWA) plugs into the same ledger later
// without changing this loop's shape. LinkMia does not use SMS.

const { createClient } = require('@supabase/supabase-js');
const notify = require('./lib/notify');

const SWEEP_FIELDS = 'id, trip_id, status, pickup_datetime, pickup_location, ' +
  'dropoff_location, customer_name, assigned_driver, driver_ready_at, ' +
  'driver_ready_by, driver_ready_source, at_risk_at, accepted_at';

const SOFT_BUDGET_MS = 8000;
const MAX_BOOKINGS = 50;
const MAX_ATTEMPTS = 15;
const AT_RISK_OFFSET_MS = 105 * 60 * 1000;
const HEARTBEAT_KEY = 'last_heartbeat_date';

exports.handler = async () => {
  const summary = {
    swept: 0, atRisk: 0, derived: 0, suppressed: 0, recovered: 0,
    attempts: 0, submitted: 0, dbErrors: 0, budgetStopped: false, heartbeat: false
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

  const rawBudget = Number(process.env.WATCHDOG_BUDGET_MS);
  const budgetMs = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : SOFT_BUDGET_MS;
  const outOfBudget = () => {
    if (Date.now() - startMs >= budgetMs) {
      summary.budgetStopped = true;
      return true;
    }
    return false;
  };
  const dbFail = (site, error) => {
    summary.dbErrors++;
    console.error(`❌ Watchdog DB failure @ ${site}:`,
      error && error.message ? error.message : error);
  };
  const finish = () => {
    const ok = summary.dbErrors === 0;
    (ok ? console.log : console.error)(
      `${ok ? '✅' : '❌'} Watchdog:`, JSON.stringify(summary));
    return { statusCode: ok ? 200 : 500, body: JSON.stringify(summary) };
  };

  try {
    // ---- B. SWEEP: one bounded query, earliest pickups first ----
    const low = new Date(nowMs - 6 * 3600e3).toISOString();
    const high = new Date(nowMs + 3 * 3600e3).toISOString();
    const { data: sweptRows, error: sweepError } = await db
      .from('bookings')
      .select(SWEEP_FIELDS)
      .or(`and(status.in.(pending,confirmed),pickup_datetime.gte.${low},pickup_datetime.lte.${high}),status.in.(on_the_way,arrived,in_progress)`)
      .order('pickup_datetime', { ascending: true })
      .limit(MAX_BOOKINGS);
    if (sweepError) {
      dbFail('sweep', sweepError);
      return finish();
    }
    const bookings = sweptRows || [];
    summary.swept = bookings.length;

    // ---- A. HEARTBEAT (budget-checked like every other phase) ----
    if (!outOfBudget()) {
      summary.heartbeat = await maybeHeartbeat(db, nowMs, dbFail);
    }

    // ---- C. OPERATIONAL STATE FIRST: at-risk stamp at T-105 ----
    for (const b of bookings) {
      if (outOfBudget()) break;
      if (b.status !== 'confirmed' || notify.readinessValid(b)) continue;
      const pickupMs = Date.parse(b.pickup_datetime);
      if (!Number.isFinite(pickupMs)) continue;
      if (nowMs >= pickupMs - AT_RISK_OFFSET_MS && nowMs < pickupMs && !b.at_risk_at) {
        const { data, error } = await db.from('bookings')
          .update({ at_risk_at: nowIso })
          .eq('id', b.id).eq('status', 'confirmed').is('at_risk_at', null)
          .select();
        if (error) {
          dbFail('at-risk stamp', error);
          continue;
        }
        if (data && data.length) {
          b.at_risk_at = nowIso;
          summary.atRisk++;
        }
      }
    }

    // ---- D. DERIVE + IDEMPOTENT INSERT (UTC instant arithmetic) ----
    if (!outOfBudget()) {
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
        const { data: inserted, error } = await db.from('notification_events')
          .upsert(eventRows, {
            onConflict: 'booking_id,event_type,recipient_key',
            ignoreDuplicates: true
          })
          .select();
        if (error) dbFail('event derivation upsert', error);
        else summary.derived = (inserted || []).length;
      }
    }

    // ---- E. SUPPRESSION: batched grouped updates, no per-booking loops ----
    if (!outOfBudget()) {
      const readyIds = [];
      const activeIds = [];
      const byId = new Map();
      for (const b of bookings) {
        byId.set(b.id, b);
        if (b.status === 'confirmed' && notify.readinessValid(b)) readyIds.push(b.id);
        else if (['on_the_way', 'arrived', 'in_progress'].includes(b.status)) activeIds.push(b.id);
      }
      const ready = await notify.suppressEvents(db, readyIds, notify.CHAIN_TYPES, 'driver_ready');
      if (ready.error) dbFail('suppress driver_ready', ready.error);
      summary.suppressed += ready.count;
      // On my way is the strongest possible readiness signal
      const active = await notify.suppressEvents(db, activeIds, notify.CHAIN_TYPES, 'driver_active');
      if (active.error) dbFail('suppress driver_active', active.error);
      summary.suppressed += active.count;

      // Recipient-keyed identity: a replacement driver gets their OWN
      // events; the old driver's pending rows are retired in ONE update.
      const assignedIds = bookings.filter((b) => b.assigned_driver).map((b) => b.id);
      if (assignedIds.length) {
        const { data: pendingDriverEvents, error: pendError } = await db
          .from('notification_events')
          .select('id, booking_id, recipient_key')
          .eq('recipient_role', 'driver')
          .in('state', ['pending'])
          .in('booking_id', assignedIds);
        if (pendError) {
          dbFail('reassignment scan', pendError);
        } else {
          const staleIds = (pendingDriverEvents || [])
            .filter((e) => {
              const b = byId.get(e.booking_id);
              return b && b.assigned_driver && e.recipient_key !== b.assigned_driver;
            })
            .map((e) => e.id);
          if (staleIds.length) {
            const { data: retired, error } = await db.from('notification_events')
              .update({ state: 'suppressed', suppress_reason: 'reassigned' })
              .in('id', staleIds)
              .in('state', ['pending'])
              .select();
            if (error) dbFail('suppress reassigned', error);
            else summary.suppressed += (retired || []).length;
          }
        }
      }
    }

    // ---- F. RECOVER: expired claims -> ambiguous (uniform, no resend) ----
    // A worker that died mid-send is indistinguishable from a lost
    // response after transmission began — terminal disposition, never an
    // automatic resend. Escalation events cover the gap.
    if (!outOfBudget()) {
      const staleIso = new Date(nowMs - notify.CLAIM_EXPIRY_MS).toISOString();
      const { data: expired, error } = await db.from('notification_deliveries')
        .update({ state: 'ambiguous', finalized_at: nowIso, last_error: 'claim expired' })
        .eq('state', 'claimed')
        .lt('claimed_at', staleIso)
        .select();
      if (error) dbFail('stale-claim recovery', error);
      else summary.recovered = (expired || []).length;
    }

    // ---- G. DISPATCH: due events -> claim-by-insert -> Telegram ----
    if (!outOfBudget()) {
      const { data: dueRows, error: dueError } = await db.from('notification_events')
        .select('*')
        .in('state', ['pending', 'in_delivery'])
        .lte('due_at', nowIso)
        .order('due_at', { ascending: true })
        .limit(30);
      if (dueError) {
        dbFail('due-event load', dueError);
        return finish();
      }
      let due = dueRows || [];

      // Chain collapse: several driver asks due at once (watchdog was
      // down) -> keep only the most urgent, suppress the rest.
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
          const { row, error } = await notify.setEventState(db, ev.id, ['pending'],
            { state: 'suppressed', suppress_reason: 'superseded' });
          if (error) dbFail('chain collapse', error);
          if (row) {
            superseded.add(ev.id);
            summary.suppressed++;
          }
        }
      }
      due = due.filter((ev) => !superseded.has(ev.id));

      for (const ev of due) {
        if (summary.attempts >= MAX_ATTEMPTS) break;
        if (outOfBudget()) break;
        await dispatchOne(db, ev, nowMs, summary, dbFail);
      }
    }

    return finish();
  } catch (error) {
    console.error('❌ Watchdog error:', error);
    summary.dbErrors++;
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error', summary }) };
  }
};

// Ride-day heartbeat with a truthful claim/finalize state machine.
// system_state.last_heartbeat_date value grammar:
//   '<date>'                 finalized — Telegram ACCEPTED today's summary
//   'claimed:<date>:<iso>'   a worker is sending (expired claims turn
//                            ambiguous, mirroring the delivery rule)
//   'failed:<date>'          pre-transmission/definitive failure —
//                            eligible to retry on the next cycle
//   'ambiguous:<date>'       transmission may have happened — NEVER
//                            blindly resent; surfaced in logs every cycle
// The date is finalized only AFTER a submitted outcome — a failed send
// never permanently consumes the day.
async function maybeHeartbeat(db, nowMs, dbFail) {
  const adminChat = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!adminChat || !process.env.TELEGRAM_BOT_TOKEN) return false;

  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: notify.MIAMI_TZ });
  const { data: row, error: readError } = await db.from('system_state')
    .select('key, value').eq('key', HEARTBEAT_KEY).maybeSingle();
  if (readError) {
    dbFail('heartbeat read', readError);
    return false;
  }
  const v = row ? row.value : null;

  if (v === today) return false; // finalized
  if (v === `ambiguous:${today}`) {
    console.warn('⚠️ Heartbeat ambiguous for today — not resending (check Telegram manually)');
    return false;
  }
  if (v && v.startsWith(`claimed:${today}:`)) {
    const ts = Date.parse(v.split(':').slice(2).join(':'));
    if (!Number.isFinite(ts) || nowMs - ts >= notify.CLAIM_EXPIRY_MS) {
      const { error } = await db.from('system_state')
        .update({ value: `ambiguous:${today}` })
        .eq('key', HEARTBEAT_KEY).eq('value', v)
        .select();
      if (error) dbFail('heartbeat claim expiry', error);
      console.warn('⚠️ Heartbeat claim expired — marked ambiguous, not resent');
    }
    return false; // in flight or just resolved — never a second send now
  }

  // Claimable: absent row, an old day's value, or failed:<today> (retry).
  const nowIsoLocal = new Date(nowMs).toISOString();
  const dayHigh = new Date(nowMs + 24 * 3600e3).toISOString();
  const { data: rideRows, error: rideError } = await db.from('bookings')
    .select('id')
    .or(`and(status.in.(pending,confirmed),pickup_datetime.gte.${nowIsoLocal},pickup_datetime.lte.${dayHigh}),status.in.(on_the_way,arrived,in_progress)`)
    .limit(50);
  if (rideError) {
    dbFail('heartbeat ride check', rideError);
    return false;
  }
  const rideCount = (rideRows || []).length;
  if (!rideCount) return false; // quiet day: silence stays meaningful

  const claimVal = `claimed:${today}:${nowIsoLocal}`;
  let won = false;
  if (!row) {
    const { data: ins, error } = await db.from('system_state')
      .upsert([{ key: HEARTBEAT_KEY, value: claimVal }],
        { onConflict: 'key', ignoreDuplicates: true })
      .select();
    if (error && !notify.isUniqueViolation(error)) {
      dbFail('heartbeat claim insert', error);
      return false;
    }
    won = Boolean(ins && ins.length);
  } else {
    const { data: upd, error } = await db.from('system_state')
      .update({ value: claimVal })
      .eq('key', HEARTBEAT_KEY).eq('value', row.value)
      .select();
    if (error) {
      dbFail('heartbeat claim update', error);
      return false;
    }
    won = Boolean(upd && upd.length);
  }
  if (!won) return false; // a concurrent run owns today's heartbeat

  const result = await notify.sendTelegram(adminChat,
    `🟢 LinkMia watchdog: alive — ${rideCount} upcoming/active ride${rideCount === 1 ? '' : 's'} today.`);

  let finalVal;
  if (result.outcome === 'submitted') {
    finalVal = today;
  } else if (result.outcome === 'ambiguous') {
    finalVal = `ambiguous:${today}`;
    console.warn('⚠️ Heartbeat send ambiguous:', result.error);
  } else {
    finalVal = `failed:${today}`; // retryable OR definitive: retry next cycle
    console.warn('⚠️ Heartbeat send failed (will retry next cycle):', result.error);
  }
  const { error: finalizeError } = await db.from('system_state')
    .update({ value: finalVal })
    .eq('key', HEARTBEAT_KEY).eq('value', claimVal)
    .select();
  if (finalizeError) dbFail('heartbeat finalize', finalizeError);

  return result.outcome === 'submitted';
}

// Dispatch one due event: refetch the live booking, re-check relevance,
// claim by insert, send, finalize, roll the event up. 'submitted' is the
// terminal success — provider acceptance is NOT proof anyone saw it.
// Every real DB failure is surfaced via dbFail; a failure never guesses
// an event outcome (the event is left for the next cycle instead).
async function dispatchOne(db, ev, nowMs, summary, dbFail) {
  const nowIso = new Date(nowMs).toISOString();
  const suppress = async (reason) => {
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'suppressed', suppress_reason: reason });
    if (error) dbFail(`suppress ${reason}`, error);
  };

  const { data: b, error: refetchError } = await db.from('bookings')
    .select(SWEEP_FIELDS).eq('id', ev.booking_id).maybeSingle();
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

  if (!process.env.TELEGRAM_BOT_TOKEN) return; // config gap: leave pending

  const chatId = ev.recipient_role === 'driver'
    ? await notify.resolveDriverChatId(db, b.assigned_driver, dbFail)
    : process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!chatId) return; // config gap, not a send failure — leave pending

  const text = notify.renderEvent(ev.event_type, b);
  if (!text) {
    await suppress('no_template');
    return;
  }

  const marked = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
    { state: 'in_delivery' });
  if (marked.error) {
    // Can't record state -> don't send: an unrecorded send could duplicate.
    dbFail('mark in_delivery', marked.error);
    return;
  }

  const claim = await notify.createDelivery(db, ev, 'telegram', chatId);
  if (claim.dbError) {
    dbFail('createDelivery', claim.dbError);
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
    // Ambiguous attempt (never resend) or attempt cap: nothing else can
    // satisfy this single-channel event — terminal, visible in the ledger.
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup exhausted', error);
    return;
  }

  summary.attempts++; // every provider call counts, success or not
  const result = await notify.sendTelegram(chatId, text);
  let fin;
  if (result.outcome === 'submitted') {
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'submitted', submitted_at: nowIso });
    if (fin.error) dbFail('finalize submitted', fin.error);
    const { error } = await notify.setEventState(db, ev.id, ['pending', 'in_delivery'],
      { state: 'submitted' });
    if (error) dbFail('rollup submitted', error);
    summary.submitted++;
  } else if (result.outcome === 'ambiguous') {
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'ambiguous', finalized_at: nowIso, last_error: result.error });
    if (fin.error) dbFail('finalize ambiguous', fin.error);
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup ambiguous', error);
  } else if (result.outcome === 'definitive') {
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso, last_error: result.error });
    if (fin.error) dbFail('finalize definitive', fin.error);
    const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
      { state: 'exhausted' });
    if (error) dbFail('rollup definitive', error);
  } else {
    // retryable: record the failure; the event stays in_delivery and the
    // next cycle creates attempt N+1 (cap enforced in createDelivery).
    fin = await notify.finalizeDelivery(db, claim.delivery.id,
      { state: 'failed', finalized_at: nowIso, last_error: result.error });
    if (fin.error) dbFail('finalize retryable', fin.error);
    if (claim.delivery.attempt_no >= notify.MAX_ATTEMPTS_PER_CHANNEL) {
      const { error } = await notify.setEventState(db, ev.id, ['in_delivery'],
        { state: 'exhausted' });
      if (error) dbFail('rollup attempt cap', error);
    }
  }
}
