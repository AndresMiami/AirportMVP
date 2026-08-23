# 3C-2C plan v5 — correction addendum

Status: design record for PR #75's migration-017 correction. It does not
authorize running SQL, enabling the quote service, changing Netlify, or changing
production.

This addendum resolves the four questions raised by the first executed review
of migration 017. It replaces the conflicting rows or prose in plan v5; every
other accepted v5 boundary remains unchanged.

## 1. Authentic stale tokens refuse new writes in every mode

An authentic token whose price hold is expired, or whose issue time is beyond
the permitted clock skew, cannot authorize a new booking or edit in `off`,
`observe`, or `enforce`. This is the single exception to plan v5's earlier
"observe never rejects" wording.

This does not strand an ambiguous successful request. Signature, identity and
exact-token digest are checked before the time verdict, so the same caller may
recover an operation that already committed. Time deferral is for that lookup
only; it is never permission for a new write.

The 2C-B endpoint must submit an authentic token whose `timeStatus` is not
valid as `p_verdict='verified'` with its verified projection; it must never
relabel it `verify_failed`. On `quote_expired` or `quote_not_yet_valid` in any
mode, future 2C-B makes the browser silently re-quote. It replaces all three
currently shipped 2B2 surfaces—the **Expired** card placeholder, the manual
**Refresh prices** banner, and the Book-time alert—with **Updating price…** and
the refreshed quote. There is no up-front "price live for 15 min" label and no
passenger-facing word "refused." That browser replacement is explicitly 2C-B
work, not part of this dark SQL correction.

## 2. Keep one temporary, nonfinancial duration snapshot

Verified creates and edits MUST NOT null the accepted duration. The
whole-minute route duration continues to populate the existing
`bookings.duration_minutes` field. SQL can prove only that this value is a
non-null integer from 1 through 1440; 2C-B MUST map the commitment-verified
`routeMinutes` into `p_booking.duration_minutes` or `p_edit.duration_minutes`
(the browser does not send a separate legacy `durationMinutes`) and must refuse
a zero-minute route rather than inventing one. This preserves the trip-page ride
estimate and operator notification while Google Routes storage-policy review is
still open. It is an accepted-quote estimate, not live tracking and not a money
authority. ETA remains a top-priority passenger metric and should be kept as
recent and accurate as the current architecture permits.

Route distance is not persisted. If policy review later rejects duration
retention, the duration/ETA consumers must be changed honestly in the same
release; the database must not silently start returning NULL while the UI still
promises an estimate. Separate future live refreshes remain the existing two-ETA
roadmap work: driver-to-pickup at **On my way**, then pickup-to-dropoff at
**Start trip**.

## 3. Exact keyed-commitment facts

The v2 keyed commitment binds these exact nine inputs:

- `mode`;
- `airportCode`;
- `placeId`;
- `pickupAtMs`;
- `passengers`;
- `routeMilesTenths`;
- `routeMinutes`;
- token field `vehicle` (called `vehicleKey` at the browser/RPC boundary); and
- `finalCents`.

In 2C-B, the Node verifier recomputes the commitment from the client-echoed
intent under the `kid`-selected signing key; consuming a quote does not make a
second provider call. Binding both route integers prevents a short-route price
from being presented with a longer route. The SQL boundary also checks the
signed projection, pickup instant, canonical airport and vehicle, and typed
booking fields. 2C-B validates both echoed integers but does not create a
durable route-facts snapshot: distance is never persisted, while whole-minute
duration continues only through today's existing `duration_minutes` field
under decision 2 until the storage-policy review concludes.

## 4. Verified quotes are consumed in off mode too

`off` determines which money is stored, not whether an authentic quote may be
reused. A verified token in `off`, `observe`, or `enforce` creates one
`quote_acceptances` row. The shared quote `jti` therefore permits one booking;
same-token/same-identity retries are idempotent and sibling vehicle tokens are
consumed conflicts. This is especially load-bearing for ambassadors: they are
deliberately exempt from the one-active-booking slot, so the acceptance receipt
is what prevents one quote from creating several guest rides.

The money matrix is:

| Mode | Stored fare | Booking authority | Verified acceptance |
|---|---:|---|---|
| off | client fare | `client_legacy` | yes |
| observe | client fare | `client_observe` | yes |
| enforce | signed server fare | `server_quote` | yes |
| blocked | no new booking | none | no |

Missing operation IDs are still accepted and telemetried in off/observe for
legacy-client compatibility. Enforce keeps the explicit outdated-client/428
response. This does not weaken the separate one-operation idempotency contract
for modern clients.

## Rollout remains gated

Migration 017 remains unrun until its production preflight is reviewed,
historical ambassador mapping is filled explicitly, and the exact
manifest-filled rollout artifact is reviewed, checksum-recorded, and passes
the executed PostgreSQL smoke and rollback. Andres must separately authorize
those exact SQL bytes. The quote service and browser flag remain disabled.

Stripe containment is a separate, explicitly postponed security track. Andres
has not made it a migration-017 or 2C-B rollout gate; postponement does not mean
the existing unauthenticated Stripe surface has been remediated.
