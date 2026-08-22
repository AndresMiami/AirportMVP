# Prototypes

Design decisions that took real work to reach, recorded so the next person to open
the question starts from the answer instead of the blank page.

**No prototype HTML is committed here, deliberately.** `netlify.toml` sets
`publish = "."`, so the deployed site serves the whole repository — any `.html` file
added to this directory becomes a real, publicly reachable production page at a
guessable URL. Verified: on `main` the path `/docs/prototypes/operations-console.html`
falls through to the catch-all and serves the booking page; on a deploy preview that
contained the file, the same path served the console mockup itself. "Not linked from
anywhere" is not the same as "not deployed."

So the mockups live outside the deployed tree, and this file records what they showed.

---

## LinkMia Operations console — north-star design

**Designed:** 2026-08-21 · **Status:** design reference only, not a commitment to build

A single self-contained page showing what the LinkMia operator console could become:
a dispatch board, a live map, fleet and account views, revenue insight, and a pricing
studio where an operator changes fares without editing code.

### Where the file lives

- Unmerged branch **`design/operations-console-mockup`** at
  `docs/prototypes/operations-console.html`. Check it out to open it; never merge it
  to `main` while the repository root is the publish directory.
- Also published as a private Claude artifact for viewing without a checkout.

It talks to no LinkMia API, uses no credentials, and contains no keys. It does make
one external request: the page links a Google Fonts stylesheet
(`fonts.googleapis.com`, which then pulls font files from `fonts.gstatic.com`).
Everything else — the pricing engine, the map, the charts — runs locally in the page.

### What is real inside it, and what is not

This matters, because a mockup that lies is worse than no mockup.

| Part | Real or invented |
|---|---|
| The pricing engine | **Real.** A browser copy of `backend/functions/lib/ride-quote.js`, verified cent-for-cent against the real engine across 5,040 route × vehicle × time combinations, with the rate card transcribed byte-identically from `ride-rate-card.js`. Every fare on every screen is computed, never typed. |
| Route distances and durations | **Real.** The traffic-aware figures measured against Google during the 3C-2B1 quote-service rollout. |
| Driver / booking / ambassador record shapes | **Real.** They match the live Supabase schema. |
| The day's rides, driver names, weekly revenue | **Invented.** The production table holds no live bookings, so a plausible day was constructed. Labelled as a demo day in the page. |
| Continuous vehicle tracking | **Invented, and loudly labelled.** See below. |

### Three findings it encodes

All were produced by running the real engine, and all survive independently of whether
this console is ever built:

1. **The pricing engine is sometimes backwards.** Raising every Tesla per-mile rate by
   10% — one edit, one direction — moves five real Miami routes by +25.6%, **−8.2%**,
   0%, +10.1% and +52.6%. A price *increase* produces a price *cut* on a real route,
   because whole-dollar rounding bands are unevenly spaced. This is live behavior today,
   and it is the entire argument for simulating a change before publishing it.

2. **The rate-card validator accepts field names it does not implement.** A card
   carrying `minimumFareCents: 8500` validates, deep-freezes and registers as a good
   card — and a 3-mile ride still quotes $19.00. Any pricing UI must be restricted to
   fields the engine provably reads, enforced by a registry and a test, or it will show
   a green check for a setting that does nothing.

3. **"Fixed" prices are not fixed, and the "hourly rate" is a floor.** A configured $150
   route bills $159 once the airport fee and rounding land on it. Raising the Escalade's
   $125/hr figure to $175/hr changes nothing at all on MIA→Brickell, FLL→Miami or
   PBI→Miami, because the floor only binds on short or badly delayed trips.

### The live map, and the tracking preview

The mockup's **Live map** screen has two modes.

*Today · verified checkpoints* is the honest current capability: three GPS fixes per
ride, each captured inside a driver tap and written in the same database operation as
the status change.

*Preview · continuous tracking* is a **placeholder for a capability LinkMia does not
have.** Vehicles animate along their routes with heading, speed and ETA. They move
because the page animates them — no driver is reporting anything. It is drawn in a
colour used nowhere else, ringed, stamped and captioned so it cannot be mistaken for
real data.

The blocker is the platform, not the code: a mobile web page stops reporting position
the moment the driver opens Google Maps for turn-by-turn, which is the first thing
every driver does after accepting. Continuous browser geolocation was built once and
deliberately removed for exactly this reason. Making it real needs a native driver
shell (Capacitor plus a background-geolocation plugin), an Apple Developer account, a
position ingest endpoint, a written retention and privacy decision, battery and
permission degradation, and a passenger-side staleness rule.

**One rule must survive if it is ever built:** continuous positions are *convenience*.
The three verified checkpoints remain the *record*. A dispute about whether a driver
was at the curb is answered by the point stamped atomically with the status change, not
by a stream of unauthenticated coordinates. A no-show still requires an Arrived
checkpoint, elapsed waiting time, an attempted contact and explicit approval.

---

## When to build any of this

**This design does not change the build order.** It is a destination, not a schedule,
and it is not a reason to reorder work:

| # | Work | Why it comes first |
|---|---|---|
| 1 | **3C-2B2** — passenger browser displays server-generated prices | The server engine is dark. Until the browser asks it for prices, everything downstream is theoretical. |
| 2 | **3C-2C** — booking and edit endpoints enforce and store the accepted quote | `create-booking` currently accepts `price` from the browser and writes it verbatim. Until that changes, a pricing dashboard is a control panel wired to nothing. |
| 3 | **Store route facts and pricing version on each booking** | Bookings save no distance, duration or card version. Without them a fare cannot be replayed or explained, and no before/after analysis of a price change is possible. |
| 4 | **Convert the three strongest pricing screens into real tools** — fare board, simulator, price receipt | These carry the findings above, and they are the cheapest: read-only, no migration, no publish button. |
| 5 | **Broader operations screens, then true moving-vehicle tracking** | Today / Rides / Fleet need no new columns and can follow whenever wanted. Real tracking is last and is a business decision with a recurring cost. |

Step 4 is the first point at which any of this becomes real code, and even then only
three screens of it. Steps 1–3 are prerequisites in the strict sense: each is unusable
without the one before it.

### What step 4 should and should not take from the mockup

**Take:** the fare board as the home screen rather than a rate table; the wrong-way
detector that blocks publishing when a fare moves opposite to the edit; the
running-total receipt (the engine's own per-surcharge amounts are computed on the
pre-surcharge base and do not sum, so only running totals add up); the rounding-band
line that explains why a small change moved nothing; and the "Can't change yet"
refusals, which are the safest screen in the product.

**Do not take:** stored publication in Supabase. Git already provides immutable
versions, authorship, a stated reason, review, history and rollback, and that workflow
already runs here. Build stored publication when someone who cannot use git needs to
change a price, or when the first negotiated account exists — not before.

**Also do not take:** scoped price lists, rule precedence, effective dating, named
places, or approval ceremony. There is one administrator and zero negotiated accounts.
Designing for multi-tenancy now would shape the schema and the vocabulary around users
who do not exist.

---

## Adding a prototype later

Before committing any prototype page to this directory, the deployment-hardening task
must land first: publish an explicit directory of approved site assets instead of the
repository root. Until then, keep mockups on an unmerged branch.

## Two alarms the mockup surfaced

Both are armed right now and are independent of anything in this directory:

- The holiday list in the rate card ends at `2026-12-25`, so holiday pricing silently
  stops applying on 1 January 2027 with no warning anywhere.
- `cancellationFeeCents` is carried and validated in the rate card but read by nothing —
  the live cancellation policy is hard-coded elsewhere.
