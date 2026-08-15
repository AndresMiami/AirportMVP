// Shared notification helpers — proactive readiness system (PR 1).
//
// This module lives in a subdirectory WITHOUT an index.js so Netlify never
// deploys it as its own endpoint; the watchdog requires it relatively and
// esbuild bundles it. It handles ONLY the new reminder events — the
// existing booking doorbell (create-booking.js) and on_my_way/complete
// receipts (update-booking-status.js) are deliberately untouched in PR 1.
//
// Channels: telegram (now) and webpush (Driver PWA, next). LinkMia does
// NOT use SMS; WhatsApp stays the human conversation channel, never
// automated. Neither channel can prove a person SAW a notification, so
// the honest terminal success state everywhere is 'submitted' — the
// provider accepted the send. There is no 'delivered' state.
//
// Ledger model (migration 011):
//   notification_events      one row = one business intention;
//                            UNIQUE (booking_id, event_type, recipient_key)
//                            states: pending / in_delivery / submitted /
//                                    exhausted / suppressed
//   notification_deliveries  one row = one channel-specific attempt.
//                            Row CREATION is the claim — the
//                            (event_id, channel, attempt_no) unique
//                            constraint arbitrates racing workers. Rows are
//                            permanent history; their state fields update
//                            in place as outcomes are determined.
//                            states: claimed / submitted / failed / ambiguous
//
// Ambiguity, uniformly: once a request MAY have reached the provider, a
// failure is 'ambiguous' — terminal, never automatically resent (a
// duplicated reminder erodes trust more than a missing one; escalation
// events cover driver inaction). Only failures that provably happened
// BEFORE transmission (DNS resolution, connection refused) — or an
// explicit provider throttle (429) — are retryable.
//
// Database errors are NEVER swallowed here: only unique-violation 23505
// is the expected "another worker won" result; every other select/insert/
// update failure is returned to the caller as { dbError } so the watchdog
// can log it and refuse to report a clean run.

const webpush = require('web-push');

const MIAMI_TZ = 'America/New_York';

// Readiness chain (PR 1): offsets are minutes BEFORE pickup. All due-time
// arithmetic is instant subtraction on the TIMESTAMPTZ pickup — UTC math,
// immune to DST wall-clock shifts; ET appears only in rendered text.
const READINESS_CHAIN = [
  { type: 'driver_ready_ask_1',     offsetMin: 150, role: 'driver' },
  { type: 'driver_ready_ask_2',     offsetMin: 135, role: 'driver' },
  { type: 'driver_ready_urgent',    offsetMin: 120, role: 'driver' },
  { type: 'admin_ready_escalation', offsetMin: 120, role: 'admin' },
  { type: 'at_risk_mark',           offsetMin: 105, role: 'admin' }
];

// Driver asks in escalation order — when several are simultaneously due
// (watchdog was down), only the LAST (most urgent) is sent; earlier ones
// are suppressed as 'superseded'. Never three pings in one invocation.
const DRIVER_ASKS = ['driver_ready_ask_1', 'driver_ready_ask_2', 'driver_ready_urgent'];

const CHAIN_TYPES = READINESS_CHAIN.map((s) => s.type);

// One-shot cancellation events, produced by the outbox trigger
// ATOMICALLY with the status flip (admin: migration 013; driver:
// migration 015) — never derived by the watchdog. Deliberately NOT in
// CHAIN_TYPES (their booking is terminal — the status!=confirmed
// relevance gate must not suppress them) and NOT in DRIVER_ASKS (never
// chain-collapsed). 'ride_cancelled' routes push-first like every
// driver event, with the duplicate_target dedup in lib/dispatch.js.
const CANCELLATION_TYPES = ['ride_cancelled', 'ride_cancelled_admin'];

// Release events (PR 3C-1), produced by the migration-016 outbox trigger
// on booking_releases INSERTs — the history row is the notification
// source. Admin-role (Telegram-only), recipient_key = the RELEASING
// driver (event identity per release). Deliberately outside CHAIN_TYPES
// (the booking is pending again — the not-confirmed gate must not
// suppress the news) and outside CANCELLATION_TYPES (a released ride is
// NOT cancelled — the not_cancelled gate would wrongly suppress it).
// A release is historical fact: no status relevance gate at dispatch,
// bounded only by the trigger's explicit six-hour not_after leash.
const RELEASE_TYPES = ['ride_released'];

const MAX_ATTEMPTS_PER_CHANNEL = 3;
const CLAIM_EXPIRY_MS = 3 * 60 * 1000;
const TELEGRAM_TIMEOUT_MS = 5000;

// Narrowly recognized pre-transmission failures — the ONLY network errors
// safe to classify as retryable. Anything else (ECONNRESET, EPIPE,
// ETIMEDOUT, unknown rejections) may have reached Telegram -> ambiguous.
const PRE_TRANSMISSION_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];

function dueAtFor(pickupIso, offsetMin) {
  return new Date(Date.parse(pickupIso) - offsetMin * 60 * 1000).toISOString();
}

// Readiness is valid ONLY while the confirming driver is still the
// assigned driver (reassignment invalidates it — code contract in the
// migration 011 header; this check is the watchdog's defense in depth).
function readinessValid(b) {
  return Boolean(b && b.driver_ready_at && b.driver_ready_by &&
    b.driver_ready_by === b.assigned_driver);
}

function tripCode(b) {
  return b.trip_id || String(b.id || '').slice(0, 8);
}

function fmtTimeET(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: MIAMI_TZ
  });
}

function fmtWhenET(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: MIAMI_TZ
  }) + ' at ' + fmtTimeET(iso);
}

function siteUrl() {
  return process.env.URL || 'https://i-love-miami.netlify.app';
}

// Reminder copy. Driver texts deep-link to the authenticated app — a
// notification NEVER carries an action that mutates ride state.
// `extra` (optional) carries per-event enrichment the booking row cannot
// provide — today only the booking_releases row for 'ride_released',
// whose SNAPSHOTS (pickup/name at release) are the rendered truth: the
// live booking is pending again and editable, so it must never
// re-classify the release. Without extra, 'ride_released' returns null
// (-> terminal no_template suppress; never a blind or wrong send).
function renderEvent(eventType, b, extra) {
  const code = tripCode(b);
  const at = fmtTimeET(b.pickup_datetime);
  const app = `${siteUrl()}/driver`;
  switch (eventType) {
    case 'driver_ready_ask_1':
      return `⏰ Ride ${code} is at ${at}. Are you still ready? Open LinkMia Driver to confirm: ${app}`;
    case 'driver_ready_ask_2':
      return `⏰ Second reminder — ride ${code} at ${at} is not confirmed ready yet. Open LinkMia Driver to confirm: ${app}`;
    case 'driver_ready_urgent':
      return `🚨 URGENT — ride ${code} at ${at} has no readiness confirmation. Open LinkMia Driver now: ${app}`;
    case 'admin_ready_escalation':
      return `🚨 Ride ${code} (${b.pickup_location} → ${b.dropoff_location}) at ${at}: driver has NOT confirmed readiness by T-120.`;
    case 'at_risk_mark':
      return `⚠️ AT RISK — ride ${code} at ${at}: no driver readiness by T-105. Marked at-risk in the database; consider calling.`;
    case 'ride_cancelled':
      // The driver's "stop" — honest and closed: the ride is gone from
      // My Rides, so no link promises details that no longer render.
      return `🚫 Ride ${code} was cancelled by the passenger. Do not proceed. No action is required.`;
    case 'ride_cancelled_admin': {
      // Renders ONLY from the row's stamped migration-013 audit fields —
      // the notification claims database truth, never a recomputation.
      const route = `${b.pickup_location} → ${b.dropoff_location}`;
      const when = fmtWhenET(b.pickup_datetime);
      if (b.cancelled_from_status === 'pending') {
        return `🚫 Request ${code} withdrawn by the passenger before acceptance.\n${route}\nPickup was ${when}.`;
      }
      const pct = b.cancel_fee_percent == null ? null : Number(b.cancel_fee_percent);
      const amt = b.cancel_fee_policy_amount == null ? null : Number(b.cancel_fee_policy_amount);
      const feeLine = Number.isFinite(pct) && Number.isFinite(amt)
        ? `\nPolicy: ${pct}% = $${amt.toFixed(2)} · pilot waived, $${Number(b.cancel_fee_collected || 0).toFixed(2)} collected`
        : '';
      return `🚫 Ride ${code} CANCELLED (was ${b.cancelled_from_status || 'active'}).\n${route}\nPickup was ${when}.${feeLine}`;
    }
    case 'ride_released': {
      // Renders ONLY from the booking_releases snapshots — the booking is
      // pending again and EDITABLE after release (PR #59), so the pickup
      // time, ROUTE, driver name, payment state, and the URGENT
      // classification all come from the IMMUTABLE release record; only
      // the trip code comes from the live row (true identity). The
      // private note is dashboard-only.
      if (!extra || !extra.pickup_at_release || !extra.driver_name_at_release || !extra.reason ||
          !extra.pickup_location_at_release || !extra.dropoff_location_at_release) {
        return null;
      }
      const releaseReasonLabel = {
        schedule_conflict: 'schedule conflict',
        ride_details_changed: 'ride details changed',
        vehicle_issue: 'vehicle issue',
        emergency: 'emergency',
        other: 'other'
      }[extra.reason] || extra.reason;
      const releasedRoute = `${extra.pickup_location_at_release} → ${extra.dropoff_location_at_release}`;
      const releasedWhen = fmtWhenET(extra.pickup_at_release);
      const urgent = Date.parse(extra.pickup_at_release) - Date.now() < 2 * 3600e3;
      // The releaser had already stamped the fare collected: the live
      // stamp is PRESERVED so the passenger is never charged twice — the
      // human must reconcile who actually holds the money.
      const paidWarning = extra.payment_status_at_release && extra.payment_status_at_release !== 'unpaid'
        ? '\n⚠️ Payment was already marked collected by the releasing driver — reconcile before pickup.'
        : '';
      return `${urgent ? '🚨 URGENT — ' : '🔄 '}Ride ${code} RELEASED by ${extra.driver_name_at_release} (${releaseReasonLabel}).\n${releasedRoute}\nPickup ${releasedWhen}.${paidWarning}\nThe request is back in the driver feed.`;
    }
    default:
      return null;
  }
}

// ---- Telegram adapter (checks response.ok, classifies outcomes) ----
// Duplicate-safety is the design center: once a request MAY have reached
// Telegram, resending risks a duplicate reminder, so the default for the
// unknown is 'ambiguous', never 'retryable'.
//
//   'submitted'   Telegram accepted the request (HTTP 2xx). Terminal
//                 success — NOT proof the driver saw anything.
//   'retryable'   safe to retry: 429 (Telegram's documented throttle —
//                 the request was explicitly not processed) or a narrowly
//                 recognized pre-transmission failure (DNS resolution,
//                 connection refused).
//   'definitive'  Telegram rejected it (other 4xx) — retrying the same
//                 request cannot succeed.
//   'ambiguous'   timeout/abort, connection reset, unknown network error,
//                 or 5xx (the request reached Telegram; its docs do not
//                 guarantee a 5xx was rejected before acceptance) —
//                 TERMINAL, never automatically resent.
async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { outcome: 'definitive', error: 'telegram not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal
    });
    if (res.ok) return { outcome: 'submitted' };
    if (res.status === 429) return { outcome: 'retryable', error: 'telegram 429' };
    if (res.status >= 500) return { outcome: 'ambiguous', error: `telegram ${res.status}` };
    return { outcome: 'definitive', error: `telegram ${res.status}` };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { outcome: 'ambiguous', error: 'telegram timeout' };
    }
    const code = (e && (e.code || (e.cause && e.cause.code))) || '';
    if (PRE_TRANSMISSION_CODES.includes(code)) {
      return { outcome: 'retryable', error: `pre-transmission ${code}` };
    }
    return { outcome: 'ambiguous', error: code || (e && e.message) || 'unknown network error' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Web Push (Driver PWA) ----
// Duplicate-safety mirrors the Telegram discipline; classifications are
// written DURABLY to notification_deliveries.failure_class so routing —
// including Telegram-fallback continuation — is restart-safe from
// delivery history alone. Endpoints and keys are SECRETS: never logged
// (logs carry the subscription row UUID), never returned by APIs, never
// cached (the driver service worker has no fetch handler).

const PUSH_TIMEOUT_MS = 5000;

// Absolute escalation deadlines (minutes before pickup): a queued ask_1
// the push service could not deliver by the ask_2 time must EXPIRE, and
// a passed deadline suppresses the send without any provider call.
const ASK_DEADLINE_MIN = {
  driver_ready_ask_1: 135, // expires when ask_2 is scheduled
  driver_ready_ask_2: 120  // expires when the urgent escalation fires
};
// Definitive webpush failure classes -> Telegram fallback begins (and,
// per the routing precedence, the event never returns to Push).
const DEFINITIVE_PUSH_CLASSES = ['expired_endpoint', 'vapid_config', 'payload', 'provider_rejected'];

const VAPID_B64URL_RE = /^[A-Za-z0-9_-]+$/;

function validVapidSubject(subject) {
  if (typeof subject !== 'string' || !subject) return false;
  try {
    const parsed = new URL(subject);
    if (parsed.protocol === 'https:') {
      return Boolean(parsed.hostname && parsed.hostname !== 'localhost');
    }
    if (parsed.protocol === 'mailto:') {
      const address = decodeURIComponent(parsed.pathname || '');
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address);
    }
    return false;
  } catch (e) {
    return false;
  }
}

function validVapidKey(value, decodedBytes) {
  if (typeof value !== 'string' || !value || !VAPID_B64URL_RE.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length === decodedBytes;
  } catch (e) {
    return false;
  }
}

// Canonical configuration check shared by the watchdog and subscription
// endpoint. A non-empty but truncated/corrupt key is NOT configured:
// routing stays on Telegram and the UI never claims Push is available.
function vapidConfigValid() {
  return validVapidSubject(process.env.VAPID_SUBJECT) &&
    validVapidKey(process.env.VAPID_PUBLIC_KEY, 65) &&
    validVapidKey(process.env.VAPID_PRIVATE_KEY, 32);
}

function pushConfigured() {
  if (process.env.PUSH_DISABLED === '1' || process.env.PUSH_DISABLED === 'true') return false;
  return vapidConfigValid();
}

// One per-booking readiness topic (32-char base64url limit respected):
// an undelivered queued ask_1 is REPLACED at the push service by ask_2,
// and the same string as notification tag collapses displayed banners.
function readinessTopic(b) {
  return 'rdy-' + String(b.id || '').replace(/-/g, '').slice(0, 24);
}

// Minimal payload: trip code + generic action line ONLY — never passenger
// name, phone, address, or notes. The authenticated app fetches details.
// ride_cancelled deliberately OMITS rideId: the cancelled ride is gone
// from My Rides, so the click opens the general driver page (driver-sw
// falls back to /driver when rideId is absent) instead of deep-linking
// to a card that no longer exists. It reuses the per-booking readiness
// tag/topic so a queued stale readiness reminder is REPLACED by the stop
// notice at the push service and in the notification tray.
function pushPayloadFor(eventType, b) {
  const code = tripCode(b);
  if (eventType === 'ride_cancelled') {
    return {
      type: 'ride',
      title: 'LinkMia Driver',
      body: `Ride ${code} was cancelled by the passenger. Do not proceed. No action is required.`,
      tag: readinessTopic(b)
    };
  }
  const body = eventType === 'driver_ready_ask_2'
    ? `Ride ${code} is still not confirmed ready. Open to confirm.`
    : `Ride ${code} — readiness check due. Open to confirm.`;
  return { type: 'ride', rideId: b.id, title: 'LinkMia Driver', body, tag: readinessTopic(b) };
}

// Outcomes mirror sendTelegram, with the durable class alongside:
//   submitted   provider accepted (NOT proof the driver saw it)
//   retryable   throttled (429) or provably pre-transmission
//   definitive  expired_endpoint (404/410 — the ONLY class that disables
//               the subscription), vapid_config (401/403 — OUR config,
//               subscription kept), payload (400/413), provider_rejected
//               (other 4xx)
//   ambiguous   5xx / timeout / unknown network — terminal, never resent
async function sendWebPush(sub, payload, { ttl, topic }) {
  if (!pushConfigured()) {
    return { outcome: 'definitive', failureClass: 'vapid_config', error: 'push vapid_missing' };
  }
  // Defense in depth: even after our canonical validation, the library
  // may reject configuration locally. That is a definitive OUR-config
  // failure, safe for Telegram fallback — never an ambiguous send.
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch (e) {
    return { outcome: 'definitive', failureClass: 'vapid_config', error: 'push vapid_invalid' };
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: ttl, urgency: 'high', topic, timeout: PUSH_TIMEOUT_MS }
    );
    return { outcome: 'submitted' };
  } catch (e) {
    const status = e && e.statusCode;
    if (status === 404 || status === 410) {
      return { outcome: 'definitive', failureClass: 'expired_endpoint', error: `push ${status}` };
    }
    if (status === 401 || status === 403) {
      // Sanitized: OUR VAPID configuration failing — never the endpoint,
      // keys, or provider response body in the error string.
      return { outcome: 'definitive', failureClass: 'vapid_config', error: `push ${status}` };
    }
    if (status === 400 || status === 413) {
      return { outcome: 'definitive', failureClass: 'payload', error: `push ${status}` };
    }
    if (status === 429) {
      return { outcome: 'retryable', failureClass: 'throttled', error: 'push 429' };
    }
    if (status >= 500) {
      return { outcome: 'ambiguous', failureClass: 'ambiguous', error: `push ${status}` };
    }
    if (status >= 400) {
      return { outcome: 'definitive', failureClass: 'provider_rejected', error: `push ${status}` };
    }
    const code = (e && (e.code || (e.cause && e.cause.code))) || '';
    if (PRE_TRANSMISSION_CODES.includes(code)) {
      return { outcome: 'retryable', failureClass: 'pre_transmission', error: `push ${code}` };
    }
    return { outcome: 'ambiguous', failureClass: 'ambiguous', error: 'push unknown' };
  }
}

// MVP device selection: the subscription the driver most recently
// ENABLED (newest activated_at) — never last_success_at, which would pin
// notifications to an old phone forever. Health lives in last_success_at.
async function selectSubscription(db, driverId) {
  const { data, error } = await db.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, activated_at')
    .eq('driver_id', driverId)
    .is('disabled_at', null)
    .order('activated_at', { ascending: false })
    .limit(1);
  if (error) return { error };
  return { sub: (data && data[0]) || null, error: null };
}

// STRICT routing precedence over delivery history — first match wins.
// Returns { done } | { channel:'telegram' } | { channel:'webpush', sub }
// | { dbError }. Once Telegram fallback has begun for an event, it never
// returns to Push.
async function resolveDriverRoute(db, ev, driverId) {
  const { data: rows, error } = await db.from('notification_deliveries')
    .select('id, channel, state, failure_class')
    .eq('event_id', ev.id);
  if (error) return { dbError: error };
  const r = rows || [];
  if (r.some((x) => x.state === 'submitted')) return { done: 'submitted' };   // 1
  if (r.some((x) => x.state === 'ambiguous')) return { done: 'exhausted' };   // 2
  if (r.some((x) => x.channel === 'telegram')) return { channel: 'telegram' }; // 3
  if (r.some((x) => x.channel === 'webpush' &&
                    DEFINITIVE_PUSH_CLASSES.includes(x.failure_class))) {
    return { channel: 'telegram' };                                            // 4
  }
  // 5 (retryable push history) and 6 (no history) collapse to the same
  // decision: Push when allowed AND a healthy subscription exists,
  // Telegram otherwise (the kill switch and a vanished device degrade
  // identically and safely).
  if (!pushConfigured()) return { channel: 'telegram' };
  const picked = await selectSubscription(db, driverId);
  if (picked.error) return { dbError: picked.error };
  if (!picked.sub) return { channel: 'telegram' };
  return { channel: 'webpush', sub: picked.sub };
}

// Driver Telegram target: drivers.telegram_chat_id, falling back to the
// admin chat (driver = admin in today's one-driver operation). A lookup
// FAILURE travels back as dbError ALONGSIDE the fallback — the caller
// decides what unknown truth means: chain reminders may still use the
// admin chat (a reminder there beats silence while the DB hiccups), but
// a cancellation decision must never treat the error-fallback as the
// driver's real chat.
async function resolveDriverChatId(db, driverId) {
  const fallback = process.env.ADMIN_TELEGRAM_CHAT_ID || null;
  if (driverId) {
    const { data, error } = await db.from('drivers')
      .select('telegram_chat_id').eq('id', driverId).maybeSingle();
    if (error) return { chatId: fallback, dbError: error };
    if (data && data.telegram_chat_id) return { chatId: data.telegram_chat_id, dbError: null };
  }
  return { chatId: fallback, dbError: null };
}

function isUniqueViolation(error) {
  return Boolean(error && error.code === '23505');
}

// ---- Delivery creation: insert-as-claim ----
// Returns exactly one of:
//   { delivery }   this worker owns the new claimed attempt — send it
//   { satisfied }  the channel already reached submitted
//   { inFlight }   an unexpired claim exists — another worker is sending
//   { blocked }    an ambiguous attempt exists — never resend this channel
//   { capped }     attempt cap reached — no more attempts allowed
//   { lost }       another worker won the insert race (23505) — skip
//   { dbError }    a REAL database failure — surface it, decide nothing
async function createDelivery(db, ev, channel, target) {
  const { data: existing, error: readError } = await db.from('notification_deliveries')
    .select('id, attempt_no, state')
    .eq('event_id', ev.id).eq('channel', channel);
  if (readError) return { dbError: readError };
  const rows = existing || [];
  if (rows.some((r) => r.state === 'submitted')) return { satisfied: true };
  if (rows.some((r) => r.state === 'claimed')) return { inFlight: true };
  if (rows.some((r) => r.state === 'ambiguous')) return { blocked: true };
  if (rows.length >= MAX_ATTEMPTS_PER_CHANNEL) return { capped: true };

  const { data, error } = await db.from('notification_deliveries')
    .insert({
      event_id: ev.id,
      channel,
      attempt_no: rows.length + 1,
      state: 'claimed',
      target: target == null ? null : String(target),
      claimed_at: new Date().toISOString()
    })
    .select();
  if (error) {
    // 23505 = the expected "another worker won the claim" outcome.
    // Anything else is a real failure the caller must surface.
    return isUniqueViolation(error) ? { lost: true } : { dbError: error };
  }
  if (!data || !data.length) return { lost: true };
  return { delivery: data[0] };
}

// Returns { error } on a real database failure — callers must not ignore it.
async function finalizeDelivery(db, deliveryId, patch) {
  const { error } = await db.from('notification_deliveries')
    .update(patch).eq('id', deliveryId).select();
  return { error: error || null };
}

// Conditional event-state transition (CAS on the allowed prior states).
// Returns { row, error }: row null + error null = CAS lost (fine);
// error non-null = real database failure the caller must surface.
async function setEventState(db, eventId, fromStates, patch) {
  const { data, error } = await db.from('notification_events')
    .update(patch).eq('id', eventId).in('state', fromStates).select();
  if (error) return { row: null, error };
  return { row: data && data.length ? data[0] : null, error: null };
}

// Suppress pending events for one or many bookings (idempotent
// conditional update, batched). Returns { count, error }.
async function suppressEvents(db, bookingIds, eventTypes, reason) {
  const ids = Array.isArray(bookingIds) ? bookingIds : [bookingIds];
  if (!ids.length) return { count: 0, error: null };
  const { data, error } = await db.from('notification_events')
    .update({ state: 'suppressed', suppress_reason: reason })
    .in('booking_id', ids)
    .in('event_type', eventTypes)
    .in('state', ['pending'])
    .select();
  if (error) return { count: 0, error };
  return { count: (data || []).length, error: null };
}

module.exports = {
  MIAMI_TZ,
  READINESS_CHAIN,
  DRIVER_ASKS,
  CHAIN_TYPES,
  CANCELLATION_TYPES,
  RELEASE_TYPES,
  MAX_ATTEMPTS_PER_CHANNEL,
  CLAIM_EXPIRY_MS,
  ASK_DEADLINE_MIN,
  DEFINITIVE_PUSH_CLASSES,
  dueAtFor,
  readinessValid,
  tripCode,
  fmtTimeET,
  fmtWhenET,
  renderEvent,
  sendTelegram,
  resolveDriverChatId,
  isUniqueViolation,
  createDelivery,
  finalizeDelivery,
  setEventState,
  suppressEvents,
  vapidConfigValid,
  pushConfigured,
  readinessTopic,
  pushPayloadFor,
  sendWebPush,
  selectSubscription,
  resolveDriverRoute
};