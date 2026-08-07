// Shared notification helpers — proactive readiness system (PR 1).
//
// This module lives in a subdirectory WITHOUT an index.js so Netlify never
// deploys it as its own endpoint; the watchdog requires it relatively and
// esbuild bundles it. It handles ONLY the new reminder events — the
// existing booking doorbell (create-booking.js) and on_my_way/complete
// receipts (update-booking-status.js) are deliberately untouched in PR 1.
//
// Ledger model (migration 011):
//   notification_events      one row = one business intention;
//                            UNIQUE (booking_id, event_type, recipient_key)
//   notification_deliveries  one row = one channel-specific attempt.
//                            Row CREATION is the claim — the
//                            (event_id, channel, attempt_no) unique
//                            constraint arbitrates racing workers. Rows are
//                            permanent history; their state fields update
//                            in place as provider results arrive.
//
// Delivery truth: 'submitted' means the provider ACCEPTED the request —
// never more. Telegram has no receipt confirmation, so Telegram events
// terminate at 'submitted'; only a provider-confirmed receipt (the signed
// SMS callback, PR 4) may ever mark 'delivered'.
//
// Ambiguity, uniformly for every channel: a timeout after transmission
// began, or a claim whose worker died (indistinguishable), is TERMINAL
// 'ambiguous' — that delivery is never automatically resent. Escalation
// events still fire on driver inaction; that is the safety net.

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
// Outcomes: 'submitted'   provider accepted the request
//           'retryable'   provably failed BEFORE transmission (conn/DNS)
//                         or a retryable provider status (429/5xx)
//           'definitive'  provider rejected it (other 4xx) — no retry
//           'ambiguous'   timed out / response lost after transmission
//                         began — never automatically resent
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
    if (res.status === 429 || res.status >= 500) {
      return { outcome: 'retryable', error: `telegram ${res.status}` };
    }
    return { outcome: 'definitive', error: `telegram ${res.status}` };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { outcome: 'ambiguous', error: 'telegram timeout' };
    }
    // Connection-level rejection before the request could transmit
    return { outcome: 'retryable', error: e.message || 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

// Driver Telegram target: drivers.telegram_chat_id, falling back to the
// admin chat (driver = admin in today's one-driver operation).
async function resolveDriverChatId(db, driverId) {
  if (driverId) {
    const { data } = await db.from('drivers')
      .select('telegram_chat_id').eq('id', driverId).single();
    if (data && data.telegram_chat_id) return data.telegram_chat_id;
  }
  return process.env.ADMIN_TELEGRAM_CHAT_ID || null;
}

// ---- Delivery creation: insert-as-claim ----
// Returns exactly one of:
//   { delivery }   this worker owns the new claimed attempt — send it
//   { satisfied }  the channel already reached submitted/delivered
//   { inFlight }   an unexpired claim exists — another worker is sending
//   { blocked }    an ambiguous attempt exists — never resend this channel
//   { capped }     attempt cap reached — no more attempts allowed
//   { lost }       another worker won the insert race — skip silently
async function createDelivery(db, ev, channel, target) {
  const { data: existing } = await db.from('notification_deliveries')
    .select('id, attempt_no, state')
    .eq('event_id', ev.id).eq('channel', channel);
  const rows = existing || [];
  if (rows.some((r) => r.state === 'submitted' || r.state === 'delivered')) {
    return { satisfied: true };
  }
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
  if (error || !data || !data.length) return { lost: true };
  return { delivery: data[0] };
}

async function finalizeDelivery(db, deliveryId, patch) {
  await db.from('notification_deliveries')
    .update(patch).eq('id', deliveryId).select();
}

// Conditional event-state transition (CAS on the allowed prior states).
async function setEventState(db, eventId, fromStates, patch) {
  const { data } = await db.from('notification_events')
    .update(patch).eq('id', eventId).in('state', fromStates).select();
  return data && data.length ? data[0] : null;
}

// Suppress pending events for a booking (idempotent conditional update).
async function suppressEvents(db, bookingId, eventTypes, reason) {
  const { data } = await db.from('notification_events')
    .update({ state: 'suppressed', suppress_reason: reason })
    .eq('booking_id', bookingId)
    .in('event_type', eventTypes)
    .in('state', ['pending'])
    .select();
  return (data || []).length;
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
  createDelivery,
  finalizeDelivery,
  setEventState,
  suppressEvents
};
