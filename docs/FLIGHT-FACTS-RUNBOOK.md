# Flight facts — runbook and sensor contract

Plan steps 1–3 of the flight-facts fast path, plus the step-4 smoke test.
Decisions (Andres, 2026-10-05):

- **D1 — mail slot.** The sensor reaches LinkMia only through
  `GET /api/flight-watchlist` and `POST /api/flight-facts`, with one revocable
  token. It never holds a database key. When AeroAPI later replaces Muse as
  the sensor, nothing on this side changes.
- **D2 — existing doorbell.** An observation's insert writes the driver event
  in the same statement (migration 021's trigger); the endpoint dispatches it
  once right away, exactly as cancel and release already do. The 5-minute
  watchdog is untouched and delivers anything that pass missed.
- **D3 — tell only.** The driver is told; `bookings.pickup_datetime` never
  moves. Readiness reminders and the "On my way" window stay on the booked
  pickup, and every alert says so ("pickup still shows 3:30 PM").

## What ships

| Piece | Where |
|---|---|
| Flight event types, message text, relevance gate | `lib/notify.js`, `lib/dispatch.js` |
| Band rules, validation, sensor auth | `lib/flight-facts.js` |
| Observation table + outbox trigger | `database/migrations/021_flight_observations.sql` |
| Sensor endpoints | `flight-watchlist.js`, `flight-facts.js` |

Not in this slice: showing facts on the driver card (step 5), widening past
the trial allowlist (step 6), retention (step 7), sensor health alert (step 8).

## Rollout

The order matters. The dispatcher must know the flight event types **before**
any can exist: an event it cannot render is permanently suppressed, which
spends that band's one-time notification for that booking.

1. **Merge and deploy.** Safe on its own: both endpoints answer 503 until a
   token is set, and nothing can create a flight event yet.
2. **Run migration 021** unedited in the Supabase SQL Editor. Expect
   `Success. No rows returned`. Any red ERROR means nothing changed; the file
   checks its own grants, RLS and trigger and rolls back on any failure.
   No watchdog pause is needed.
3. **Find your driver id:**
   ```sql
   SELECT id, name, status FROM drivers ORDER BY name;
   ```
4. **Set three Netlify variables** (Site configuration → Environment
   variables), Production context, Functions scope:

   | Variable | Value | Secret |
   |---|---|---|
   | `FLIGHT_SENSOR_TOKEN` | 32+ random characters, e.g. `openssl rand -base64 48` | yes |
   | `FLIGHT_SENSOR_DRIVER_ALLOWLIST` | your driver id from step 3 | no |
   | `FLIGHT_SENSOR_DISABLED` | leave unset | no |

   `FLIGHT_SENSOR_DRIVER_ALLOWLIST` fails closed: unset or empty means
   **nobody**. `*` means every driver (step 6, later).
5. **Redeploy.** Netlify functions read variables at deploy time.
6. **Give the token to the sensor.** It is the only credential the sensor
   ever needs.

> **Before leaving the token set: your real rides are in the trial too.**
> The allowlist works per *driver*, and you drive real passengers. While your
> id is on it, every real passenger's arrival you accept appears on the
> watchlist: flight number, airport, Miami date and pickup time (never a name
> or phone). That is passenger data reaching an outside service, and the
> public Privacy page does not name the sensor yet (decision D8).
> Until D8 is settled, set the token only for the step-4 smoke test and clear
> it again afterwards (step 5 above, redeploy). Clearing it locks the sensor
> out completely.

## Step 4 — prove it end to end

One band, one driver (you), timed by the database's own clocks.

1. Book a test ride as a passenger: **pickup at MIA** ("pick me up at the
   airport"), by flight, with a real flight number, a few hours out.
2. Accept it in the driver app. Make sure push is enabled on your phone.
3. Read the watchlist:
   ```bash
   curl -s https://linkmia.com/api/flight-watchlist \
     -H "Authorization: Bearer $FLIGHT_SENSOR_TOKEN"
   ```
   Your ride should appear with exactly six fields.
4. Post one test observation, 75 minutes late (use the `bookingId`,
   `flightNumber`, `pickupDate` and `airportCode` the watchlist returned;
   times must carry a zone):
   ```bash
   curl -s -X POST https://linkmia.com/api/flight-facts \
     -H "Authorization: Bearer $FLIGHT_SENSOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"bookingId":"<id>","flightNumber":"<AA100>","pickupDate":"<YYYY-MM-DD>",
          "airportCode":"MIA","status":"active",
          "scheduledArrival":"<landing, e.g. 2026-10-06T19:00:00Z>",
          "estimatedArrival":"<landing + 75 min>",
          "observedAt":"<now, UTC>","source":"test"}'
   ```
   Expect `201` with `"band":"delay_60"` and `"notification":"submitted"`,
   and a push on your phone reading roughly: *"AA100 now lands 4:15 PM,
   75 min late. Ride LM-XXXX pickup still shows 3:30 PM. Checked 2:58 PM."*
5. **Measure the seconds:**
   ```sql
   SELECT o.recorded_at,
          e.created_at  AS event_created,
          d.channel, d.submitted_at,
          d.submitted_at - o.recorded_at AS stored_to_sent
     FROM flight_observations o
     JOIN notification_events e
       ON e.booking_id = o.booking_id AND e.event_type = 'flight_' || o.band
     LEFT JOIN notification_deliveries d ON d.event_id = e.id
    WHERE o.booking_id = '<id>' AND o.source = 'test'
    ORDER BY o.recorded_at;
   ```
6. Post the **same** request again: expect `200` and `"duplicate":true`, and
   no second push.
7. Cancel the test ride from the trip page when done. Test observations stay
   in the history, marked `source = 'test'`.

The refusals (wrong token, mismatched flight, released ride, cancelled ride,
driver outside the trial, the watchdog backstop) are proven by the test
suites and need no live test.

## Stopping it

| Need | Do | Effect |
|---|---|---|
| Pause the sensor | `FLIGHT_SENSOR_DISABLED=1`, redeploy | Both endpoints 503; already-queued alerts still deliver |
| Cut the sensor off for good | Clear or change `FLIGHT_SENSOR_TOKEN`, redeploy | The old token stops working everywhere |
| Remove the feature | Pause first, then the ROLLBACK block at the foot of migration 021 | Table and trigger gone. Its first statement retires pending flight events; **do not skip it** — a leftover event would hold back every readiness reminder each cycle |

---

## Sensor contract (for Muse, and later AeroAPI)

### Authentication

Every request: `Authorization: Bearer <FLIGHT_SENSOR_TOKEN>`. Server to server
only; there is no CORS and no browser use.

### `GET /api/flight-watchlist`

Arrivals worth tracking right now: rides picked up at the airport, confirmed
or under way, with a driver committed, pickup between 6 hours ago and 72
hours ahead, driver in the trial allowlist.

```json
{
  "generatedAt": "2026-10-06T14:00:00.000Z",
  "window": { "pastHours": 6, "aheadHours": 72 },
  "flights": [{
    "bookingId": "123e4567-e89b-42d3-a456-426614174000",
    "flightNumber": "AA100",
    "pickupDate": "2026-10-06",
    "airportCode": "MIA",
    "pickupAt": "2026-10-06T19:30:00.000Z",
    "rideStatus": "confirmed"
  }]
}
```

`pickupDate` is the booking's **Miami** date. Echo it back unchanged; it is
how LinkMia knows you are still describing the ride as it stands.
`flightNumber` is normalized (`aa 100` → `AA100`); rides whose flight field
is not a real designator are left out, never guessed at.

### `POST /api/flight-facts`

One observation per request. Unknown fields are refused.

| Field | Required | Rule |
|---|---|---|
| `bookingId`, `flightNumber`, `pickupDate`, `airportCode` | always | As the watchlist gave them |
| `status` | always | `active` · `cancelled` · `diverted` · `landed` |
| `scheduledArrival` | always | ISO timestamp **with a zone** |
| `estimatedArrival` | while `active` | ISO with zone, within −12h/+48h of schedule |
| `actualArrival` | once `landed` | ISO with zone |
| `observedAt` | always | When you read it. Not in the future, not older than 6 hours |
| `source` | always | Short lowercase slug: `muse`, `aeroapi`, `test` |

**You do not send a band; LinkMia derives it.** Delay is
`round((estimated − scheduled) / 1 min)`; 120+ is `delay_120`, 60+ is
`delay_60`, 30+ is `delay_30`, otherwise `on_time`. `cancelled`, `diverted`
and `landed` are their own bands.

**When to write:** once when a ride first appears on the watchlist, then only
when the band you compute changes, or the status changes. Writing more often
is harmless, just wasteful: each band alerts the driver at most once per ride.
A retry must reuse the **same** `observedAt`; that is what makes it
idempotent.

Who hears what: `delay_30`, `delay_60`, `delay_120`, `cancelled`, `diverted`
alert the assigned driver. `on_time` and `landed` are recorded silently. An
improving flight sends nothing (decision D5 is still open).

### Responses

| Code | Meaning | What the sensor should do |
|---|---|---|
| `201` | Stored. See `notification` below | Carry on |
| `200` `duplicate:true` | Same reading already stored | Carry on |
| `400` | The request breaks this contract | Fix the sender; do not retry as-is |
| `401` | Wrong token | Stop and tell a human |
| `404` | Booking does not exist | Drop it |
| `409` `refreshWatchlist:true` | The ride changed: different flight, date, airport, status, or driver outside the trial | Re-read the watchlist; drop or re-match |
| `413` | Body over 4 KB | Fix the sender |
| `503` | Switched off or not configured on LinkMia's side | Back off (15 min), retry |
| `500` | LinkMia could not read or store | Retry with backoff, same `observedAt` |

`notification` on a `201`:

| Value | Meaning |
|---|---|
| `null` | This band tells no one |
| `submitted` | Sent by this request; a provider accepted it (not proof it was read) |
| `deferred` | Stored; the watchdog delivers it within about 5 minutes |
| `suppressed` | Judged not news for this driver (e.g. the ride was just released) |
| `failed` | Every channel attempt was used up |
| `already_notified` | This band was announced earlier for this ride |
| `not_created` | The ride changed between the check and the insert |

Error responses never contain database text. Times in alerts are always
Miami time.

## Still open (Andres)

- **D4** — who else is told (Andres? pending rides with no driver?)
- **D5** — landing, early arrival, recovery: silent today
- **D6** — show facts on the driver card (step 5)
- **D7** — retention of observations (step 7). Today they are append-only and
  kept; a ride's rows go only if the booking itself is deleted
- **D8** — whose commercial flight-data license; FlightAware's position on
  showing data to another operator's drivers; the public Privacy page must
  name the sensor and its data source **before the token stays set** —
  Andres's own real rides are inside the trial (see the note under Rollout)
- **D9** — sensor health alert (step 8)
- **D10** — departures (arrivals only today)
