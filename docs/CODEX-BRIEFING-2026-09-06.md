# Briefing for Codex — where we are, where we're going

**Date:** 2026-09-06 · **Branch:** `claude/analyze-driver-booking-mvp-m9xA1` · **Base:** `main` @ `66100a1`

Purpose: a shared, code-checked picture before the next decision. Every claim below
was verified against the files named, on `main`, today. Where I could **not** verify
(live database state), it says so rather than repeating the record.

The design direction this briefs against is the booking-flow design record; its
"Order of work" is section 4 here.

---

## 1. Where we are — three lanes

### Lane A · Server pricing — one rung further along than `CLAUDE.md` says

| Rung | State | Evidence |
|---|---|---|
| Engine + quote service | shipped | `lib/ride-rate-card.js`, `lib/ride-quote.js`, `quote-ride.js` |
| Writer swap (PR #76) | shipped | `create-booking.js`, `update-pending-booking.js` → `accept_quote_*` |
| Edit quoting + envelope (PR #77) | shipped | `quote-ride.js` edit purpose, `indexMVP.html` |
| Migration 017 | run in production 2026-08-23 | runbook + record |
| Kill switch off, observe mode | set | record only — **not verifiable this session** |
| **Browser flag** | **merged and deployed** | **PR #88 `2660538`, commit `0ac62ea`, Sep 4** |
| Graduation evidence → enforce | not started | — |

**Correction to the record:** `CLAUDE.md` still describes the browser flag as
"branch browser-flag-activation — local, under review, NOT merged or deployed."
It merged as PR #88 two days ago. `indexMVP.html:758` reads
`const SERVER_QUOTE_ENABLED = true;` and `service-worker.js` carries
`linkmia-v1.3.27` / `linkmia-runtime-v4` — the activation pair. Passengers are
seeing and submitting server prices now, stamped `price_authority='client_observe'`.

So the next pricing step is not activation. It is **graduation evidence**: zero
non-test `no_request_id` / `no_token` / `verify_failed` rows in
`quote_verifications`. That is a database question, and the Supabase MCP server
failed to connect this session (connection failure, not a missing capability) —
it needs a hand-run query.

### Lane B · Ride changes

Release ride (PR 3C-1, migration 016) is shipped and field-tested. Pending-edit
is shipped. **Manage Ride (confirmed-ride editing) is not built** — the only
groundwork is `accept_optional_edit`, which exists in migration 017
(`017_quote_enforcement_foundation.sql:1938`), is granted to `service_role`, and
has no caller anywhere in `backend/`. It was shipped deliberately unused and
reserved for exactly this.

### Lane C · Booking-flow redesign

Prototypes v5/v6/v7 + brief live in `docs/mockups/` on `claude/booking-flow-mockup`;
that directory is force-404'd by `netlify.toml`. Nothing in the production flow
changed. v7 is the current direction: **the route decides the journey** — an
airport in Pickup means arrival, an airport in Destination means departure, and
the passenger is never asked.

---

## 2. Three corrections to the record

These matter more than the status table, because two of them are things I got
wrong and one is a decision that has already been answered elsewhere.

**(a) Airport-to-airport is expressible today, and is already being sold.**

The design record says: *"One airport code, one place id… neither can be
expressed, so neither can be priced, so neither is offered."* That is wrong, and
so is the matrix row marking `MIA → FLL` as "Not yet".

`ALLOWED_FIELDS` (`quote-ride.js:59`) is
`['mode','airportCode','placeId','pickupAt','passengers']`. `airportCode` is a
hard whitelist of MIA/FLL/PBI; `placeId` is **any Google place** — airports
included. So `airportCode: 'MIA'` + `placeId:` FLL's place resolves, routes, and
prices. Andres books it in production; the observed quote was $95 / $135 / $189.

My error was equating the *shape of the request* with the *set of bookable
trips*. Point-to-point genuinely cannot be expressed (no `airportCode` to send).
Airport-to-airport always could.

What it actually prices as: an ordinary distance-tiered ride from the coded
airport, with **one** airport fee (`ride-quote.js:356`, unconditional). The
rate card's `FLL-PBI` / `PBI-FLL` flat rates never fire — the card itself
records why, at `ride-rate-card.js:116`: *"popular-route flat rates … are
UNREACHABLE in production booking (the caller passes a Google place_id as the
destination, never an airport code)."*

Two live consequences:

1. **A pricing question, not a UI one.** Is one airport fee the right price for
   a two-airport trip? Today's answer is accidental, not chosen.
2. **v7 is internally inconsistent.** It refuses airport-to-airport when both
   ends come from LinkMia's verified list, but a Google-autocompleted "Fort
   Lauderdale Airport" passes as an ordinary `place` and is allowed. It blocks
   the well-identified path and permits the sloppy one. My recommendation: allow
   it, and put any restriction in the rate card, where the design record's own
   "Still open" section already suggests it belongs.

**(b) The duration/ETA question is answered, not pending.**

The design record lists "any ETA or trip duration anywhere in the flow" as
absent *pending the Google content-retention decision*. That decision came back
NO (case 74801827), and R1 / migration 018
(`018_r1_route_content_non_retention.sql`, commit `fd396e3`) implements it:
duration is never persisted, verified writes no longer require it, and edits
clear legacy values. The absence of ETA is now permanent policy, not a hold.
The *address*-retention question remains genuinely open on its own track.

**(c) `/api/track-flight` is a reserved route with nothing behind it.**

The design record calls it "the reserved `/api/track-flight` endpoint … the
front door." Half right: the redirect **is** reserved (`netlify.toml:45-48`),
but `backend/functions/track-flight.js` does not exist, so the path currently
resolves to a missing function. Worth stating plainly so nobody plans against a
front door that opens onto nothing — and worth a decision on whether an
unbacked public route should sit in the config at all.

The good news is the storage half is already real: `flight_number` is an
existing `bookings` column and travels through both write RPCs
(`018_r1_route_content_non_retention.sql:430,1195`). A flight-number release
needs a provider call and a buffer rule — not a schema change.

---

## 3. What the reverse lookup added (merged, inert)

`airportByPlaceId` in `lib/place-identity.js:129` maps a stored place id back to
the LinkMia airport it identifies. It reads our own registry, calls nothing,
stores nothing. Verified against the real production value: the stored address
`2100 NW 42nd Ave, Miami, FL 33142, USA` resolves to *MIA — Miami International
Airport*.

It exists because correction (a) has a display consequence: on an
airport-to-airport booking, one end renders as a name and the other as a raw
street address, on both the driver card and the trip page.

**It is not wired to anything, deliberately.** Wiring it crosses a boundary
someone drew on purpose: `DRIVER_FIELDS` in `driver-bookings.js` is an explicit
allowlist that excludes `canonical_place_id`, narrowed in PR #76 so migration-017
columns stop leaking into driver responses. Adding a field back is a review
decision, not a display tweak. It also touches two API surfaces and two
front-ends, and both API tests pin exact payloads.

One residual spotted while checking that allowlist: `DRIVER_FIELDS`
(`driver-bookings.js:20`) still selects `duration_minutes`. R1 stopped writing
it and clears it on edit, and no surface displays it any more, so this is dead
weight rather than a leak — but it is a column we have decided not to keep,
still being read out to the driver app.

There is also a prior question: `canonical_place_id` is populated **only on
verified writes** (`bookings_route_identity_check`). Whether the existing
airport-to-airport bookings actually carry it is unknown until someone runs:

```sql
select id, airport_code, canonical_place_id, price_authority
from bookings order by created_at desc limit 5;
```

---

## 4. Where we're going — the order, re-costed against code

The design record's sequence, with what each step actually costs now:

1. **Finish server-pricing stabilisation.** Not activation — that shipped.
   Graduation evidence, then enforce. Both need their own authorisation.
2. **Manage Ride (PR 3C-3).** `accept_optional_edit` is waiting with no caller.
   This is the edit machinery any flight-driven rescheduling would reuse, which
   is why it precedes the flight work rather than following it.
3. **The route adapter.** Small and genuinely small: airport in Pickup →
   `mode:'pickup'`, airport in Destination → `mode:'dropoff'`. It speaks the new
   screen's shape to today's unchanged contract.
4. **The interface**, at whatever fidelity the platform supports by then.
5. **Route Intent v2** (ports, true point-to-point) last. The passenger screen
   would not need redesigning; the contract, the signed token, the stored route
   identity, the rate card and the tests all expand behind it.

---

## 5. What we'd like Codex to rule on

1. **Airport-to-airport.** Given it already prices and sells: keep it, price it
   deliberately (one airport fee or two?), and drop v7's refusal — or block it in
   the rate card. The one option I'd argue against is leaving the current state,
   where the product exists but nobody chose it.
2. **Graduation gate.** Is "zero non-test `no_request_id`/`no_token`/
   `verify_failed`" over some observation window the whole gate, or does enforce
   also need a stated minimum volume and a per-airport spread?
3. **Sequence check.** Manage Ride before the booking-flow rearrangement — agreed?
   The alternative is shipping the redesigned screens against today's capabilities
   and retrofitting later.

Two smaller items carried from the design record, still open and still
operations' call rather than engineering's: the arrival buffer figures (the
prototype uses 30 domestic / 45 international as placeholders; the repo plan
contradicts itself, 35–40 + 30 customs in its body vs 45 in its own decision
table), and which flight data provider — number lookup and schedules search are
different products at different prices.

---

**Not changed by this briefing:** production behaviour, the route contract, or
any pricing rung. This is a status document. `main` is green — 30 suites pass.
