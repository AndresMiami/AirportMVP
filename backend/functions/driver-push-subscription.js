// Driver Web Push subscription management (Authorization: Bearer JWT).
//   GET    /api/driver-push-subscription?deviceId=<uuid>
//            -> { state, vapidPublicKey, endpointFingerprint? }
//               state: 'none' | 'enabled' | 'expired'
//               endpointFingerprint: sha256 hex of the STORED endpoint so
//               the client can prove "enabled" means browser and server
//               hold the SAME subscription. The endpoint itself and the
//               encryption keys are SECRETS and never leave the server.
//   POST   /api/driver-push-subscription
//            { deviceId, subscription: { endpoint, keys: { p256dh, auth } } }
//            -> { ok: true }  (upsert bound to driver + device; stamps
//               activated_at — the device-selection key)
//            -> 409 when the endpoint belongs to ANOTHER driver: an
//               endpoint is NEVER reassigned between accounts; the client
//               must unsubscribe browser-side and subscribe fresh.
//   DELETE /api/driver-push-subscription   { deviceId }
//            -> { ok: true }  (sign-out cleanup; the row is deleted, so
//               no 'signed_out' disabled state exists)
//
// Server-side validation is strict — junk is 400 and never stored:
// deviceId must be a UUID; endpoint a well-formed https: URL (length
// capped); p256dh/auth base64url within sane bounds. Every response is
// private, no-store.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const notify = require('./lib/notify');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ENDPOINT_LEN = 2048;

// Endpoints are contacted SERVER-SIDE later, so an arbitrary https URL
// from a compromised driver account would become a server-side request
// to an attacker-chosen destination. Only recognized browser push
// services are accepted (exact host or a dot-boundary suffix).
const PUSH_HOST_SUFFIXES = [
  '.push.apple.com',              // Safari/iOS (e.g. web.push.apple.com)
  '.push.services.mozilla.com',   // Firefox autopush shards
  '.notify.windows.com'           // Edge (WNS)
];
const PUSH_HOSTS_EXACT = [
  'web.push.apple.com',
  'fcm.googleapis.com',           // Chrome/Chromium (FCM)
  'updates.push.services.mozilla.com'
];
function allowedPushHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (PUSH_HOSTS_EXACT.includes(host)) return true;
  return PUSH_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx) && host.length > sfx.length);
}

async function requireDriver(event, supabaseUrl, anonKey, db) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, error: 'Not authenticated' };

  const authClient = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) return { status: 401, error: 'Invalid session' };

  const { data: driver, error: driverError } = await db
    .from('drivers')
    .select('id, name, status')
    .eq('user_id', userData.user.id)
    .single();
  if (driverError || !driver) return { status: 403, error: 'No driver account' };
  if (driver.status !== 'active' && driver.status !== 'busy') {
    return { status: 403, error: 'Driver account inactive' };
  }
  return { driver };
}

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LEN) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch (e) {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;      // no embedded credentials
  if (url.port) return false;                          // standard port only
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return false;
  if (/^[0-9.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false; // no IP literals
  if (!allowedPushHost(host)) return false;            // recognized push services only
  if (!keys || typeof keys !== 'object') return false;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || p256dh.length < 40 || p256dh.length > 200 ||
      !B64URL_RE.test(p256dh)) return false;
  if (typeof auth !== 'string' || auth.length < 10 || auth.length > 100 ||
      !B64URL_RE.test(auth)) return false;
  return true;
}

const fingerprint = (endpoint) =>
  crypto.createHash('sha256').update(endpoint).digest('hex');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (!['GET', 'POST', 'DELETE'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('❌ Missing Supabase configuration');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);

  const auth = await requireDriver(event, supabaseUrl, anonKey, db);
  if (!auth.driver) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }
  const driver = auth.driver;

  try {
    if (event.httpMethod === 'GET') {
      const deviceId = (event.queryStringParameters || {}).deviceId || '';
      if (!UUID_RE.test(deviceId)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid deviceId' }) };
      }
      const { data: row, error } = await db.from('push_subscriptions')
        .select('endpoint, disabled_at')
        .eq('driver_id', driver.id)
        .eq('device_id', deviceId)
        .maybeSingle();
      if (error) {
        // Sanitized: database messages can echo stored values (endpoints).
        console.error('❌ Subscription lookup failed:', error.code || 'db error');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
      }
      const configured = notify.pushConfigured();
      const body = {
        state: !row ? 'none' : (row.disabled_at ? 'expired' : 'enabled'),
        pushConfigured: configured,
        vapidPublicKey: configured ? process.env.VAPID_PUBLIC_KEY : null
      };
      if (row && !row.disabled_at) body.endpointFingerprint = fingerprint(row.endpoint);
      return { statusCode: 200, headers, body: JSON.stringify(body) };
    }

    const parsed = JSON.parse(event.body || '{}');
    const deviceId = parsed.deviceId || '';
    if (!UUID_RE.test(deviceId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid deviceId' }) };
    }

    if (event.httpMethod === 'DELETE') {
      const { error } = await db.from('push_subscriptions')
        .delete()
        .eq('driver_id', driver.id)
        .eq('device_id', deviceId);
      if (error) {
        console.error('❌ Subscription delete failed:', error.code || 'db error');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Delete failed' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // POST — enable / re-enable
    const sub = parsed.subscription;
    if (!validSubscription(sub)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid subscription payload' }) };
    }

    // An endpoint is NEVER reassigned between driver accounts.
    const { data: owner, error: ownerError } = await db.from('push_subscriptions')
      .select('driver_id')
      .eq('endpoint', sub.endpoint)
      .maybeSingle();
    if (ownerError) {
      console.error('❌ Endpoint ownership check failed:', ownerError.code || 'db error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
    }
    if (owner && owner.driver_id !== driver.id) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Subscription in use by another account — resubscribe freshly' })
      };
    }

    // Same driver re-registering this endpoint from another device row:
    // retire the stale row first so the endpoint UNIQUE can't collide.
    const { error: cleanupError } = await db.from('push_subscriptions')
      .delete()
      .eq('driver_id', driver.id)
      .eq('endpoint', sub.endpoint)
      .neq('device_id', deviceId);
    if (cleanupError) {
      console.error('❌ Stale-row cleanup failed:', cleanupError.code || 'db error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed' }) };
    }

    const nowIso = new Date().toISOString();
    const { data: saved, error: saveError } = await db.from('push_subscriptions')
      .upsert([{
        driver_id: driver.id,
        device_id: deviceId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: String(event.headers['user-agent'] || '').slice(0, 300),
        activated_at: nowIso,   // the device-selection key: newest enable wins
        disabled_at: null,
        disabled_reason: null,
        last_error: null
      }], { onConflict: 'driver_id,device_id' })
      .select('id');
    if (saveError) {
      // Two drivers can pass the ownership lookup CONCURRENTLY; the
      // endpoint UNIQUE constraint then rejects the loser. That race is
      // the same promise as the pre-check: sanitized 409, never a 500.
      if (saveError.code === '23505') {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'Subscription in use by another account — resubscribe freshly' })
        };
      }
      console.error('❌ Subscription save failed:', saveError.code || 'db error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed' }) };
    }
    if (!saved || !saved.length) {
      // An empty result is a failed save, not a success.
      console.error('❌ Subscription save returned no row');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed' }) };
    }
    console.log(`✅ Push subscription active for driver ${driver.id} (device ${deviceId.slice(0, 8)}…)`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    // Never log the full object: thrown client/network errors can contain
    // request context, including a stored endpoint. Codes/names only.
    const safeCode = (error && (error.code || error.name)) || 'unexpected';
    console.error('❌ driver-push-subscription error:', safeCode);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
