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
function renderEvent(eventType, b) {
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

// Driver Telegram target: drivers.telegram_chat_id, falling back to the
// admin chat (driver = admin in today's one-driver operation). A lookup
// failure is REPORTED via onDbError but still falls back — a reminder to
// the admin chat beats silence while the DB hiccups.
async function resolveDriverChatId(db, driverId, onDbError) {
  if (driverId) {
    const { data, error } = await db.from('drivers')
      .select('telegram_chat_id').eq('id', driverId).maybeSingle();
    if (error && onDbError) onDbError('resolveDriverChatId', error);
    if (data && data.telegram_chat_id) return data.telegram_chat_id;
  }
  return process.env.ADMIN_TELEGRAM_CHAT_ID || null;
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
  MAX_ATTEMPTS_PER_CHANNEL,
  CLAIM_EXPIRY_MS,
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
  suppressEvents
};
