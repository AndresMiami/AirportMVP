// Proactive readiness watchdog — Netlify Scheduled Function (PR 1).
// Declared in netlify.toml:  [functions."notification-watchdog"]
//                            schedule = "*/5 * * * *"
//
// Runs ONLY on published production deploys and is not exposed as a URL
// endpoint. Documented platform limit is 30 s; this handler enforces an
// 8 s soft budget across EVERY phase and inside every sequential DB loop
// (WATCHDOG_BUDGET_MS override for tests), plus hard caps: 50 bookings
// and ONE GLOBAL provider-call ceiling — MAX_ATTEMPTS (15) counts every
// Telegram call this invocation makes, heartbeat included, success or
// failure ('submitted' successes are tracked separately).
// Kill switch: WATCHDOG_DISABLED=1.
//
// One invocation:
//   B. SWEEP      one bounded bookings query, EARLIEST PICKUP FIRST and
//                 LEAN: confirmed rides from now to +3h (readiness only
//                 applies to upcoming confirmed rides — pending rows and
//                 already-past confirmed rows are excluded so abandoned
//                 records can never crowd the 50-row limit ahead of an
//                 imminent ride) plus active statuses for suppression.
//   C. AT-RISK    stamp bookings.at_risk_at at T-105 — a conditional
//                 UPDATE that is INDEPENDENT of Telegram delivery.
//                 Telegram is the alert channel; the DB is the truth.
//   D. DERIVE     idempotent event inserts. at_risk_mark derives ONLY
//                 from a stamped at_risk_at — the message claims the DB
//                 state, so it must come FROM the DB state.
//   E. SUPPRESS   moot chains (ready / advanced / reassigned), BATCHED
//   F. RECOVER    expired claims -> ambiguous (uniform, never resent)
//   A. HEARTBEAT  AFTER the operational database phases, so "alive" is a
//                 claim about the WHOLE cycle: a broken database cycle
//                 never sends a green heartbeat. Sealed claim/finalize
//                 state machine in system_state (see maybeHeartbeat):
//                 bounded retries, terminal definitive/ambiguous, one
//                 global attempt counter.
//   G. DISPATCH   claim-by-insert, send Telegram, roll events up.
//                 GATED TWICE (after F and after A) and STOPPED MID-LOOP:
//                 whenever any database work fails (summary.dbErrors>0),
//                 no further notification is sent this cycle — a cycle
//                 that cannot trust its own writes must not talk to the
//                 outside world; the next cycle retries from DB truth.
//                 A provider call that already happened cannot be
//                 undone, but nothing follows it on a broken cycle.
//
// Every step is an ON CONFLICT insert, a conditional UPDATE, or a
// unique-arbitrated row creation — overlapping invocations degrade to
// wasted work, never duplicate sends. A LOST event-state CAS means
// another process changed the event: dispatch stops for that event
// without sending. No exactly-once from the platform is assumed.
//
// Database failures are never swallowed: only unique-violation 23505 is
// an expected outcome (a lost claim race). Every real failure increments
// summary.dbErrors, is logged with its site, and forces a 500 response.
//
// PR 1 scope: readiness chain only, Telegram only. Web Push (Driver PWA,
// then authenticated-passenger PWA) plugs into the same ledger later
// without changing this loop's shape. LinkMia does not use SMS.

const { createClient } = require('@supabase/supabase-js');
const notify = require('./lib/notify');
// Per-event dispatch execution lives in the SHARED dispatcher (PR 3A
// extraction — verbatim move, no behavior change): the watchdog and the
// future cancellation endpoint use one trusted executor. Loop-level
// orchestration (sweep, derivation, suppression, chain collapse, budget,
// dbErrors gates, heartbeat) deliberately stays HERE.
const dispatch = require('./lib/dispatch');

const SWEEP_FIELDS = 'id, trip_id, status, pickup_datetime, pickup_location, ' +
  'dropoff_location, customer_name, assigned_driver, driver_ready_at, ' +
  'driver_ready_by, driver_ready_source, at_risk_at, accepted_at';

const SOFT_BUDGET_MS = 8000;
const MAX_BOOKINGS = 50;
const MAX_ATTEMPTS = 15;          // global provider-call cap, heartbeat included
const HEARTBEAT_MAX_ATTEMPTS = 3; // per-day cap for RETRYABLE heartbeat failures
const AT_RISK_OFFSET_MS = 105 * 60 * 1000;
const HEARTBEAT_KEY = 'last_heartbeat_date';

exports.handler = async () => {
  const summary = {
    swept: 0, atRisk: 0, derived: 0, suppressed: 0, recovered: 0,
    attempts: 0, submitted: 0, dbErrors: 0, budgetStopped: false,
    dispatchSkipped: false, heartbeat: false
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
    // ---- B. SWEEP: one bounded LEAN query, earliest pickups first ----
    // Readiness only ever applies to UPCOMING confirmed rides: pending
    // rows have no assigned driver to remind and past confirmed rows can
    // no longer need reminders (every chain event carries not_after =
    // pickup) — excluding both keeps abandoned records from filling the
    // 50-row limit ahead of imminent rides. Active statuses stay in for
    // suppression/recovery bookkeeping.
    const high = new Date(nowMs + 3 * 3600e3).toISOString();
    const { data: sweptRows, error: sweepError } = await db
      .from('bookings')
      .select(SWEEP_FIELDS)
      .or(`and(status.eq.confirmed,pickup_datetime.gte.${nowIso},pickup_datetime.lte.${high}),status.in.(on_the_way,arrived,in_progress)`)
      .order('pickup_datetime', { ascending: true })
      .limit(MAX_BOOKINGS);
    if (sweepError) {
      dbFail('sweep', sweepError);
      return finish();
    }
    const bookings = sweptRows || [];
    summary.swept = bookings.length;

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
          // The at_risk_mark message claims the DB state — a failed stamp
          // means no such claim may be made (also enforced in D and by the
          // dbErrors dispatch gate before G).
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
          // at_risk_mark says "marked in the database" — it derives ONLY
          // from a booking whose at_risk_at is actually stamped.
          if (spec.type === 'at_risk_mark' && !b.at_risk_at) continue;
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

    // ---- E. SUPPRESSION: batched grouped updates, budget between each ----
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
      if (!outOfBudget()) {
        // On my way is the strongest possible readiness signal
        const active = await notify.suppressEvents(db, activeIds, notify.CHAIN_TYPES, 'driver_active');
        if (active.error) dbFail('suppress driver_active', active.error);
        summary.suppressed += active.count;
      }

      // Recipient-keyed identity: a replacement driver gets their OWN
      // events; the old driver's pending rows are retired in ONE update.
      const assignedIds = bookings.filter((b) => b.assigned_driver).map((b) => b.id);
      if (assignedIds.length && !outOfBudget()) {
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

    // ---- OPERATIONAL GATE: broken cycle -> no heartbeat, no dispatch ----
    // If ANY database work failed above, this cycle's view of the truth
    // is suspect — a green "alive" heartbeat would be a lie and a
    // reminder could claim state that was never stored (e.g. an at-risk
    // mark). Send NOTHING; the next cycle retries from database truth
    // (the un-finalized heartbeat day stays claimable).
    if (summary.dbErrors > 0) {
      summary.dispatchSkipped = true;
      console.error('❌ Watchdog: skipping heartbeat + dispatch — database failures this cycle');
      return finish();
    }

    // ---- A. HEARTBEAT: after operational truth is established ----
    // "Watchdog alive" is a claim about the whole cycle, so it runs only
    // once the database phases succeeded. Budget-checked; its provider
    // call counts against the global MAX_ATTEMPTS cap.
    if (!outOfBudget()) {
      summary.heartbeat = await maybeHeartbeat(db, nowMs, summary, dbFail);
    }
    if (summary.dbErrors > 0) {
      // Heartbeat bookkeeping itself hit the database and failed — same
      // rule: nothing further is sent on a broken cycle.
      summary.dispatchSkipped = true;
      console.error('❌ Watchdog: skipping dispatch — heartbeat database failure');
      return finish();
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
      // down) -> keep only the most urgent, suppress the rest. Budget-
      // checked inside the loop like every other sequential DB loop.
      const byBooking = new Map();
      for (const ev of due) {
        if (ev.state === 'pending' && notify.DRIVER_ASKS.includes(ev.event_type)) {
          if (!byBooking.has(ev.booking_id)) byBooking.set(ev.booking_id, []);
          byBooking.get(ev.booking_id).push(ev);
        }
      }
      const superseded = new Set();
      let collapseStopped = false;
      for (const asks of byBooking.values()) {
        if (collapseStopped || asks.length < 2) continue;
        asks.sort((a, b) =>
          notify.DRIVER_ASKS.indexOf(a.event_type) - notify.DRIVER_ASKS.indexOf(b.event_type));
        for (const ev of asks.slice(0, -1)) {
          if (outOfBudget()) { collapseStopped = true; break; }
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
      if (summary.dbErrors > 0) {
        // A collapse failure means a stale ask may still look pending —
        // same rule as the gate above: no sends on a broken cycle.
        summary.dispatchSkipped = true;
        console.error('❌ Watchdog: skipping dispatch — database failures during collapse');
        return finish();
      }

      for (const ev of due) {
        if (summary.attempts >= MAX_ATTEMPTS) break;
        if (outOfBudget()) break;
        await dispatch.dispatchOne(db, ev, nowMs,
          { summary, dbFail, maxAttempts: MAX_ATTEMPTS });
        if (summary.dbErrors > 0) {
          // A DB failure INSIDE dispatch breaks the cycle's trust the
          // same as one before it. The provider call that may already
          // have happened cannot be undone — but no subsequent event may
          // send from this broken cycle.
          summary.dispatchSkipped = true;
          console.error('❌ Watchdog: stopping dispatch — database failure during dispatch');
          break;
        }
      }
    }

    return finish();
  } catch (error) {
    console.error('❌ Watchdog error:', error);
    summary.dbErrors++;
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error', summary }) };
  }
};

// Ride-day heartbeat — SEALED claim/finalize state machine.
// system_state.last_heartbeat_date value grammar:
//   '<date>'                 finalized — Telegram ACCEPTED today's summary
//   'claimed:<date>:<iso>'   a worker is sending (expired claims turn
//                            ambiguous, mirroring the delivery rule)
//   'failed:<date>:<n>'      n retryable attempts so far — eligible to
//                            retry until HEARTBEAT_MAX_ATTEMPTS (3)
//   'exhausted:<date>'       terminal for the day: a DEFINITIVE provider
//                            rejection (one call, no 288-calls-a-day
//                            loop on a misconfigured chat id) or the
//                            retry cap was reached
//   'ambiguous:<date>'       transmission may have happened — NEVER
//                            blindly resent; surfaced in logs
// The date is finalized only AFTER a submitted outcome, every provider
// call here counts against the invocation's global MAX_ATTEMPTS cap, and
// the CAS claim keeps concurrent workers to a single attempt.
async function maybeHeartbeat(db, nowMs, summary, dbFail) {
  const adminChat = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!adminChat || !process.env.TELEGRAM_BOT_TOKEN) return false;
  if (summary.attempts >= MAX_ATTEMPTS) return false;

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
  if (v === `exhausted:${today}`) {
    console.warn('⚠️ Heartbeat terminally failed for today — not retrying (check Telegram config)');
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

  let priorAttempts = 0;
  const failedPrefix = `failed:${today}:`;
  if (v && v.startsWith(failedPrefix)) {
    priorAttempts = parseInt(v.slice(failedPrefix.length), 10) || 0;
    if (priorAttempts >= HEARTBEAT_MAX_ATTEMPTS) return false; // defensive
  }

  // Claimable: absent row, an old day's value, or failed:<today>:<n<cap>.
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

  summary.attempts++; // heartbeat counts against the GLOBAL provider cap
  const result = await notify.sendTelegram(adminChat,
    `🟢 LinkMia watchdog: alive — ${rideCount} upcoming/active ride${rideCount === 1 ? '' : 's'} today.`);

  let finalVal;
  if (result.outcome === 'submitted') {
    finalVal = today;
    summary.submitted++;
  } else if (result.outcome === 'ambiguous') {
    finalVal = `ambiguous:${today}`;
    console.warn('⚠️ Heartbeat send ambiguous — terminal for today:', result.error);
  } else if (result.outcome === 'definitive') {
    finalVal = `exhausted:${today}`; // ONE call total on a misconfiguration
    console.warn('⚠️ Heartbeat rejected by Telegram — terminal for today:', result.error);
  } else {
    const next = priorAttempts + 1;
    finalVal = next >= HEARTBEAT_MAX_ATTEMPTS
      ? `exhausted:${today}`
      : `failed:${today}:${next}`;
    console.warn(`⚠️ Heartbeat send failed (attempt ${next}/${HEARTBEAT_MAX_ATTEMPTS}${next >= HEARTBEAT_MAX_ATTEMPTS ? ' — retry cap reached, terminal for today' : ', will retry'}):`, result.error);
  }
  const { error: finalizeError } = await db.from('system_state')
    .update({ value: finalVal })
    .eq('key', HEARTBEAT_KEY).eq('value', claimVal)
    .select();
  if (finalizeError) dbFail('heartbeat finalize', finalizeError);

  return result.outcome === 'submitted';
}

// dispatchOne / executeTelegram / executeWebPush moved VERBATIM to
// lib/dispatch.js (PR 3A) — one dispatcher for the watchdog and the
// future cancellation endpoint. Only dispatchOne is exported there.
