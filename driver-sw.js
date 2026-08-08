/**
 * LinkMia Driver service worker — scope '/driver' (registered by
 * driver.html; longest-prefix scope matching keeps every other page on
 * the root service worker).
 *
 * Deliberately has NO fetch handler: the driver app is never cached by
 * this worker, so driver code is always fresh and no ride data or
 * subscription material can land in a cache.
 *
 * Push payloads are minimal (trip code + generic action line) and are
 * parsed DEFENSIVELY: malformed or missing data renders a generic
 * notification instead of throwing. rideId is validated against the
 * UUID pattern and URI-encoded before it ever reaches a URL —
 * notification clicks focus an existing /driver window when one exists,
 * otherwise open /driver?ride=<id>; the AUTHENTICATED app fetches the
 * real ride details itself. Notifications never mutate ride state.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (e) {
    data = null; // malformed payload -> generic notification, never a throw
  }
  const title = (data && typeof data.title === 'string' && data.title.slice(0, 80)) || 'LinkMia Driver';
  const body = (data && typeof data.body === 'string' && data.body.slice(0, 200)) || 'Open LinkMia Driver';
  const tag = (data && typeof data.tag === 'string') ? data.tag.slice(0, 64) : undefined;
  const rideId = (data && typeof data.rideId === 'string' && UUID_RE.test(data.rideId))
    ? data.rideId
    : null;

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,               // same per-booking tag: newer reminders REPLACE older banners
    icon: '/images/driver-icon-192.png',
    badge: '/images/driver-icon-192.png',
    data: { rideId }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rideId = event.notification.data && event.notification.data.rideId;
  const valid = typeof rideId === 'string' && UUID_RE.test(rideId);
  const url = valid ? `/driver?ride=${encodeURIComponent(rideId)}` : '/driver';

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = wins.find((w) => {
      try { return new URL(w.url).pathname.indexOf('/driver') === 0; } catch (e) { return false; }
    });
    if (existing) {
      await existing.focus();
      // The open app selects/highlights the ride itself (preserved until
      // its bookings finish loading — no race with an in-flight refresh).
      existing.postMessage({ type: 'open-ride', rideId: valid ? rideId : null });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
