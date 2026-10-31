# Pricing graduation evidence — October 2026 (observe → enforce gate)

STATUS: **EVIDENCE GATHERED 2026-10-30 (15:14–15:16 UTC).** Andres authorized
the read-only production SELECTs in §3 ("Yes, run them", relayed through the
authoring session's parent session); they ran through the Supabase MCP
`execute_sql` against project `qvtqqggtpxesfcmpftej`, one plain `SELECT` per
call, exactly as written. No write of any kind was issued. **Graduation
verdict: PASS at the ledger level (§6).** Nothing in this document is an
authorization of anything; `enforce` remains Andres's separate decision in
every case.

REVISION 2 (2026-10-30): Codex reviewed revision 1 (commit `c3325b5`,
read-only — Codex independently re-read the same ledger facts and ran no
manipulated-price write) and asked for five documentation corrections,
applied in this revision's commit as one docs-only change: §8(b)'s proof
matrix now LEADS with the valid-token / altered-browser-price case on both
lanes; option (a) no longer resets identity sequences (and says why a reset
is unsafe); option (b)'s isolation is a verifiable pre-flight checklist
(database and auth target, notification overrides, blast radius and restore)
and "zero production risk" is conditional on it; §7's `blocked` line states
what blocked mode actually refuses; §5 rule 3 classifies known test traffic
by booking/operation, not by identity, and the LM-EFFA note is neutral. The
verdict in §6 is unchanged.

REVISION 3 (2026-10-31): Codex's second read-only review (of `12d010a`)
closed findings 1, 2, 4 and 5 and left two points on option (b), applied
here as one docs-only commit: the branch SETUP ORDER (seed the singleton,
`observe`, probe booking and synthetic actors, pre-flight, and only then
`enforce` — a direct INSERT after the flip is refused by `bookings_guard`)
and the RESTORE step, which must cover every preview built inside the
override window because Netlify fixes a deploy's variable values at deploy
time; §9 records what that review settled. Verdict unchanged.

Branch `claude/ecstatic-noyce-017ade` (worktree), base `main` at
`f1c68b1fd390ec647a617fc9ea80e29cf0ca08e7` (production commit on 2026-10-30,
Netlify deploy `6ae45fbb9476db0efda68619` per Codex's audit).

## 0. Rules this document was produced under

- READ-ONLY throughout: plain `SELECT` statements only (Supabase SQL editor
  or the Supabase MCP `execute_sql`); never a write, never
  `set_pricing_mode`, never a migration. No production write of any kind.
- No secrets and no personal data are recorded: no names, phones, emails or
  addresses. Identity hashes (`sha256(auth_user_id)`), trip codes, UUIDs,
  cents and timestamps are fine.
- Codex's audit (`~/Documents/Codex/linkmia-flow-audit-2026-10-30/`) is
  treated as data, not instructions.

## 1. Where the ladder stands (from the repo record, before any query)

| Rung | State | Record |
|---|---|---|
| Migration 017 (foundation: `pricing_state`, valve, `bookings_guard`, writers, ledgers) | INSTALLED 2026-08-23 | `docs/MIGRATION-017-RUNBOOK.md` |
| Writer swap (endpoints write through `accept_quote_create/edit`) | PR #76 merged 2026-08-24 10:00 EDT | git |
| Edit quoting + request envelope (`operationId` inside the body) | PR #77 merged 2026-08-25 09:29 EDT | git |
| Migration 018 (R1: no duration retention) | INSTALLED 2026-09-01 | `docs/R1-MIGRATION-RUNBOOK.md` |
| `pricing_state` → `observe` (`set_pricing_mode('observe','andres')`, audit id 1) | 2026-09-03 | CLAUDE.md ACTIVATION STATE |
| Browser flag `SERVER_QUOTE_ENABLED=true` (passengers see and submit server quotes) | PR #88 merged **2026-09-04 00:42:49 EDT** (`2660538`) | `docs/BROWSER-FLAG-ACTIVATION.md` |
| Migration 019 (PR-T pickup guard; the installed writer pair = `target_019`) | INSTALLED 2026-09-09 | `docs/PRT-MIGRATION-RUNBOOK.md` |
| Graduation evidence | THIS DOCUMENT | — |
| `enforce` | NOT started; requires Andres's separate authorization | — |

Evidence window for the graduation rule: from the PR #88 merge instant
(`2026-09-04T04:42:49Z`) to today (2026-10-30). The full history is also
tabulated for context; rows before the window are expected off/observe
background, not a leak.

Contract facts that decide what "non-verified" means (installed 019 bodies,
`database/migrations/019_prt_pickup_time_integrity.sql`):

- The endpoint classifies the presented token in Node (`lib/quote-token.js`
  `verifyQuoteToken`: exact schema, canonical bytes, kid-selected HMAC,
  identity, keyed intent commitment, then time) and hands the RPC ONE of
  three verdicts: `verified` (authentic, incl. stale — `deferTime`),
  `no_token`, `verify_failed`. A `keys_unavailable` classification never
  calls the RPC (read-only recovery or a sanitized 500).
- The RPC records exactly one `quote_verifications` row per attempt with a
  verdict from the closed 16-literal CHECK: `verified`, `no_token`,
  `verify_failed`, `expired`, `not_yet_valid`, `replay_idempotent`,
  `would_quote_consumed`, `quote_consumed`, `replay_identity_mismatch`,
  `replay_context_mismatch`, `rejected_no_token`, `rejected_invalid`,
  `blocked`, `no_request_id`, `edit_conflict`, `active_conflict`.
  `rejected_*` and `quote_consumed` can only be written in `enforce`;
  `blocked` only in `blocked`. `client_cents`/`server_cents` are stamped on
  the success-path row (`server_cents` only when the verdict was
  `verified`).
- In `observe` the RPC persists the BROWSER price (`price_authority =
  'client_observe'`) and consumes the token; only `enforce` persists the
  signed `finalCents` with `price_authority = 'server_quote'`.
- The PR-T guard writes NO verdict row (an elapsed pickup leaves nothing on
  the create lane; on the edit lane an operationId-less caller leaves its
  pre-existing `no_request_id` row — the browser always sends an
  operationId).

Graduation rule applied (CLAUDE.md, `docs/BROWSER-FLAG-ACTIVATION.md`):
**zero UNEXPLAINED non-verified rows in the window**, where "explained" is
(a) a known controlled booking by Andres or Codex, (b) the stale-tab drain
immediately after the flag release (open booking tabs keep the flag they
loaded until the next navigation), or (c) a benign registry outcome that the
browser contract produces by design (retries, CAS conflicts) and that is
traceable to a verified lane. The named instruments are `no_token`,
`no_request_id`, `verify_failed`; every other non-`verified` verdict is also
listed and classified.

## 2. Local evidence already in hand (run today, 2026-10-30, Node 24.22.1, TZ America/New_York)

| Suite | Result | What it executes |
|---|---|---|
| `tests/booking-writer.test.js` | ALL 35 CHECKS PASS | REAL v2 tokens through the actual verifier: tampered token with a working resolver → `verify_failed` (with digest); wrong identity → `verify_failed`; short secret → `keys_unavailable`, never `verify_failed`; the outcome registry (428 `outdated_client`/`quote_required` reload, 409 `quote_invalid`/`quote_expired`/`quote_stale` requote, unknown → sanitized 500). |
| `tests/quote-enforcement-foundation.test.js` | ALL 30 CHECKS PASS | Pins migration 017's contract incl. "enforce smoke proves server money wins and direct pricing writes are fenced", the transition matrix and the high-water valve. |
| `tests/quote-ride.test.js` | ALL 51 CHECKS PASS | Quote service contract (signed tokens, key rotation, sanitized telemetry, kill switch) against mocks. |
| `tests/prt-pickup-integrity.test.js` | ALL 34 CHECKS PASS | REAL PostgreSQL (PGlite): chains schema + 001..017 → 018 → 019 and EXECUTES the authority matrix for BOTH installed writers — {off, observe} × {verified, no_token, verify_failed} plus **enforce × verified** (observe → enforce reached only through `set_pricing_mode`, high-water mark set), the registry refusals of unverified calls in enforce, receipt-first replay, final-clock rollback of booking/acceptance/receipt/telemetry. |
| `tests/r1-migration-chain.test.js` | ALL 12 CHECKS PASS | The migration chain on real PostgreSQL. |

Production precedent for a rollback-contained enforce smoke: migration 017's
own self-verification block RAN IN PRODUCTION on 2026-08-23 inside the
install transaction. It called `set_pricing_mode('enforce',
'migration-017-smoke')`, asserted that an enforce create with a DIFFERENT
browser price stored the token's cents with `server_quote` authority and
`client_cents IS NULL` on the acceptance ("enforce create did not use server
money" / "... edit ..."), that `no_token` → `quote_required` and
`verify_failed` → `quote_invalid` with no booking, that a direct INSERT and
a direct ride-intent UPDATE are refused after the high-water mark while
lifecycle updates pass, that a missing operation id → `outdated_client`,
that `blocked` blocks, and that `enforce → observe` is refused by the valve —
then forced a rollback with a sentinel exception (`ZZ017`), reset both
identity sequences with `setval` (inside an install transaction that held
NOWAIT exclusive table locks from the top level — a fence option (a) does
not have; §8(a) explains why the sketch never resets a sequence), and proved
zero residue including `mode = 'off' AND enforcement_started_at IS NULL`
(`017_quote_enforcement_foundation.sql` ≈ lines 3292–3560). That is the
pattern option (a) in §8 reuses, minus the sequence reset — against today's
`observe` baseline and the installed 019 writer bodies, which the 017 block
never saw.

## 3. The exact read-only SQL (reviewed by Andres BEFORE execution, run 2026-10-30 — nothing below writes)

Through the MCP each statement runs alone as a single `SELECT`. In the SQL
editor wrap each one as `BEGIN; SET TRANSACTION READ ONLY; <statement>;
ROLLBACK;` (the 019 preflight discipline: one grid per unit). The window
boundary is the PR #88 merge instant. Timestamps are reported in UTC and in
America/New_York (`day_ny`).

```sql
-- E0. Server clock (for the day bucketing).
SELECT now() AS server_now_utc,
       now() AT TIME ZONE 'America/New_York' AS server_now_ny,
       current_setting('TimeZone') AS session_tz;

-- E1. Current pricing state (expect observe, NULL high-water mark).
SELECT mode, enforcement_started_at, updated_at
FROM public.pricing_state WHERE singleton;

-- E2. Full mode-transition audit (expect exactly one row: off -> observe).
SELECT id, actor, from_mode, to_mode, at
FROM public.pricing_state_audit ORDER BY id;

-- E3. Ledger shape, full history: verdict x mode x purpose.
SELECT verdict, mode, purpose, count(*) AS rows,
       min(created_at) AS first_at, max(created_at) AS last_at
FROM public.quote_verifications
GROUP BY 1, 2, 3 ORDER BY 2, 1, 3;

-- E4. Per day (America/New_York), full history.
SELECT (created_at AT TIME ZONE 'America/New_York')::date AS day_ny,
       mode, verdict, purpose, count(*) AS rows
FROM public.quote_verifications
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;

-- E5. The graduation window only (since the PR #88 merge instant).
SELECT verdict, mode, purpose, count(*) AS rows
FROM public.quote_verifications
WHERE created_at >= '2026-09-04T04:42:49Z'
GROUP BY 1, 2, 3 ORDER BY 2, 1, 3;

-- E6. EVERY non-verified row, full history, with its booking context
--     (trip code and status only; no contact fields).
SELECT q.id, q.created_at,
       q.created_at AT TIME ZONE 'America/New_York' AS at_ny,
       q.mode, q.verdict, q.purpose, q.identity_hash, q.booking_id,
       b.trip_id, b.status AS booking_status, b.price_authority,
       q.client_cents, q.server_cents, (q.jti IS NOT NULL) AS has_jti
FROM public.quote_verifications q
LEFT JOIN public.bookings b ON b.id = q.booking_id
WHERE q.verdict <> 'verified'
ORDER BY q.created_at, q.id;

-- E7. Verified rows: browser vs server cents (expect mismatching = 0).
SELECT mode, purpose, count(*) AS rows,
       count(*) FILTER (WHERE client_cents = server_cents) AS matching,
       count(*) FILTER (WHERE client_cents IS DISTINCT FROM server_cents) AS mismatching,
       count(*) FILTER (WHERE client_cents IS NULL OR server_cents IS NULL) AS null_cents
FROM public.quote_verifications
WHERE verdict = 'verified'
GROUP BY 1, 2 ORDER BY 1, 2;

-- E8. Any verified mismatch, row by row (expect zero rows).
SELECT q.id, q.created_at, q.mode, q.purpose, q.identity_hash,
       q.client_cents, q.server_cents, b.trip_id
FROM public.quote_verifications q
LEFT JOIN public.bookings b ON b.id = q.booking_id
WHERE q.verdict = 'verified' AND q.client_cents IS DISTINCT FROM q.server_cents
ORDER BY q.created_at;

-- E9. The acceptance ledger (consumed tokens) as a second cents cross-check.
SELECT purpose, authority, count(*) AS rows,
       count(*) FILTER (WHERE client_cents = final_cents) AS matching,
       count(*) FILTER (WHERE client_cents IS DISTINCT FROM final_cents) AS mismatching,
       min(created_at) AS first_at, max(created_at) AS last_at
FROM public.quote_acceptances
GROUP BY 1, 2 ORDER BY 1, 2;

-- E10. bookings.price_authority per day inside the window
--      (expect client_observe + canonical for every new booking;
--       with_duration must be 0 — R1).
SELECT (created_at AT TIME ZONE 'America/New_York')::date AS day_ny,
       price_authority, route_authority, count(*) AS rows,
       count(*) FILTER (WHERE duration_minutes IS NOT NULL) AS with_duration
FROM public.bookings
WHERE created_at >= '2026-09-04T04:42:49Z'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- E11. bookings authority, full history (context: backfill / client_legacy /
--      client_observe; server_quote must be 0 before enforce).
SELECT price_authority, route_authority, count(*) AS rows,
       min(created_at) AS first_at, max(created_at) AS last_at
FROM public.bookings
GROUP BY 1, 2 ORDER BY 1, 2;

-- E12. Any booking in the window with NO writer trace (no telemetry row and
--      no operation receipt) — a non-RPC write would show here (expect none).
SELECT b.id, b.trip_id, b.created_at, b.status, b.price_authority, b.route_authority
FROM public.bookings b
WHERE b.created_at >= '2026-09-04T04:42:49Z'
  AND NOT EXISTS (SELECT 1 FROM public.quote_verifications q WHERE q.booking_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM public.operation_receipts r WHERE r.booking_id = b.id)
ORDER BY b.created_at;

-- E13. The known controlled bookings -> their identity hashes (the same
--      sha256(auth_user_id) the RPC stamps), so test traffic is classified
--      by DATA, not by assumption.
SELECT b.trip_id, b.created_at, b.status, b.price_authority, b.details_version,
       encode(extensions.digest(c.user_id::text, 'sha256'), 'hex') AS identity_hash
FROM public.bookings b
JOIN public.customers c ON c.id = b.customer_id
WHERE b.trip_id IN ('LM-ZZDJ', 'LM-SR92', 'LM-EFFA')
ORDER BY b.created_at;

-- E14. Aggregate profile of EVERY identity hash that appears on a
--      non-verified row (counts and dates only): a test account shows only
--      cancelled rides; a real passenger shows completed ones.
WITH ids AS (
  SELECT DISTINCT identity_hash FROM public.quote_verifications WHERE verdict <> 'verified'
), acct AS (
  SELECT encode(extensions.digest(c.user_id::text, 'sha256'), 'hex') AS identity_hash,
         c.id AS customer_id
  FROM public.customers c WHERE c.user_id IS NOT NULL
)
SELECT i.identity_hash,
       count(DISTINCT a.customer_id) AS customer_rows,
       count(b.id) AS bookings,
       count(b.id) FILTER (WHERE b.status = 'completed') AS completed,
       count(b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled,
       min(b.created_at) AS first_booking, max(b.created_at) AS last_booking,
       (SELECT count(*) FROM public.quote_verifications q
          WHERE q.identity_hash = i.identity_hash) AS verification_rows,
       (SELECT count(*) FROM public.quote_verifications q
          WHERE q.identity_hash = i.identity_hash AND q.verdict = 'verified') AS verified_rows
FROM ids i
LEFT JOIN acct a ON a.identity_hash = i.identity_hash
LEFT JOIN public.bookings b ON b.customer_id = a.customer_id
GROUP BY i.identity_hash
ORDER BY first_booking NULLS LAST;
```

Guard cross-check (names, fingerprints and ACL booleans only — the migrations
listing is empty, so the catalog is the evidence):

```sql
-- G1. The guard functions exist with the right security shape; the two
--     writer fingerprints must equal the 019 "INSTALLS (target)" values
--     (bed37756… create, 0acb7079… edit) from docs/PRT-MIGRATION-RUNBOOK.md.
SELECT p.proname, p.oid::regprocedure AS signature, p.prosecdef,
       encode(extensions.digest(p.prosrc, 'sha256'), 'hex') AS body_sha256,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('set_pricing_mode', 'pricing_state_guard', 'bookings_guard',
                    'accept_quote_create', 'accept_quote_edit', 'accept_optional_edit',
                    'linkmia_pickup_is_future')
ORDER BY p.proname;

-- G2. The five foundation triggers, enabled ('O').
SELECT c.relname, t.tgname, t.tgenabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND t.tgname IN ('bookings_guard_trg', 'pricing_state_guard_trg',
                   'pricing_state_truncate_guard_trg', 'pricing_state_audit_guard_trg',
                   'pricing_state_audit_truncate_guard_trg')
ORDER BY 1, 2;

-- G3. The 017 constraints on bookings, the one-active-slot index, and the
--     closed verdict CHECK (16 literals, not widened).
SELECT c.conrelid::regclass AS rel, c.conname, c.contype,
       CASE WHEN c.conname = 'quote_verifications_verdict_check'
            THEN (SELECT count(*) FROM regexp_matches(pg_get_constraintdef(c.oid), '''[a-z_]+''', 'g'))
       END AS verdict_literals
FROM pg_constraint c
WHERE (c.conrelid = 'public.bookings'::regclass
         AND c.conname IN ('bookings_price_authority_check', 'bookings_route_authority_check',
                           'bookings_route_identity_check', 'bookings_price_cents_equal_check',
                           'bookings_price_nonnegative_check', 'bookings_assignment_epoch_check'))
   OR (c.conrelid = 'public.quote_verifications'::regclass
         AND c.conname = 'quote_verifications_verdict_check')
UNION ALL
SELECT 'public.bookings'::regclass, indexname, 'i', NULL
FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'bookings_one_active_per_customer'
ORDER BY 1, 2;

-- G4. The identity sequences a rollback-contained smoke would advance
--     (names and counters only) — input to option (a)'s residue plan.
SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1;

-- G5. Activity snapshot (context for any future quiet window).
SELECT count(*) FILTER (WHERE status NOT IN ('completed', 'cancelled', 'declined')) AS nonterminal,
       count(*) AS total_bookings, now() AS snapshot_at
FROM public.bookings;
```

G6 is the Supabase MCP `list_migrations` call (expected: empty, as Codex
reported).

## 4. Evidence tables (verbatim results, 2026-10-30)

E0 — server clock: `2026-10-30 15:14:49 UTC` = `11:14:49` America/New_York;
session TimeZone `UTC`.

E1 — `pricing_state`: **mode `observe`, `enforcement_started_at` NULL**,
`updated_at 2026-09-03 04:56:48 UTC`.

E2 — `pricing_state_audit` (complete): exactly ONE row — id 1, actor
`andres`, `off → observe`, at `2026-09-03 04:56:48 UTC`.

E3 — ledger shape, full history (92 rows):

| verdict | mode | purpose | rows | first (UTC) | last (UTC) |
|---|---|---|---|---|---|
| verified | observe | create | 38 | 2026-09-04 05:26:47 | 2026-10-30 09:44:19 |
| verified | observe | edit | 25 | 2026-09-04 14:53:01 | 2026-10-30 09:57:55 |
| no_request_id | off | create | 11 | 2026-08-24 14:20:04 | 2026-09-03 01:44:54 |
| no_request_id | off | edit | 3 | 2026-08-24 15:39:03 | 2026-09-02 00:42:42 |
| no_token | off | create | 12 | 2026-08-24 14:20:04 | 2026-09-03 01:44:54 |
| no_token | off | edit | 3 | 2026-08-24 15:39:03 | 2026-09-02 00:42:42 |

No other verdict value exists in the table: zero `verify_failed`, `expired`,
`not_yet_valid`, `replay_*`, `would_quote_consumed`, `quote_consumed`,
`rejected_*`, `blocked`, `edit_conflict`, `active_conflict` rows ever.

E4 — per day (America/New_York):

| day_ny | mode | verdict | create | edit |
|---|---|---|---|---|
| 2026-08-24 | off | no_request_id | 6 | 2 |
| 2026-08-24 | off | no_token | 6 | 2 |
| 2026-08-26 | off | no_request_id / no_token | 1 / 1 | – |
| 2026-08-27 | off | no_request_id / no_token | 1 / 1 | – |
| 2026-08-30 | off | no_request_id / no_token | 1 / 1 | – |
| 2026-09-01 | off | no_request_id | 1 | 1 |
| 2026-09-01 | off | no_token | 2 | 1 |
| 2026-09-02 | off | no_request_id / no_token | 1 / 1 | – |
| 2026-09-04 | observe | verified | 6 | 2 |
| 2026-09-05 | observe | verified | 2 | – |
| 2026-09-06 | observe | verified | 1 | – |
| 2026-09-07 | observe | verified | 3 | – |
| 2026-09-09 | observe | verified | 4 | 1 |
| 2026-09-10 | observe | verified | 8 | 14 |
| 2026-09-11 | observe | verified | 6 | 3 |
| 2026-09-12 | observe | verified | 1 | – |
| 2026-09-13 | observe | verified | 1 | – |
| 2026-09-16 | observe | verified | 1 | – |
| 2026-09-17 | observe | verified | 1 | – |
| 2026-09-20 | observe | verified | 1 | – |
| 2026-10-26 | observe | verified | 1 | – |
| 2026-10-27 | observe | verified | 1 | – |
| 2026-10-30 | observe | verified | 1 | 5 |

Nothing was written between 2026-09-03 01:44 UTC (last `off` row) and
2026-09-04 05:26 UTC (first `verified` row): the observe switch and the flag
release fell inside one quiet gap, so there are no `observe` + `no_token`
rows at all — not even a stale-tab drain.

E5 — the window (since `2026-09-04T04:42:49Z`): **verified/observe/create 38,
verified/observe/edit 25, nothing else.** Zero non-verified rows in the
window.

E6 — every non-verified row, full history (29 rows; all `mode = off`,
`price_authority = client_legacy`, `has_jti = false`, `server_cents` NULL):

| id | at (UTC) | verdict | purpose | identity | trip | booking status | client_cents |
|---|---|---|---|---|---|---|---|
| 1 | 2026-08-24 14:20:04 | no_request_id | create | A | LM-GSZF | cancelled | – |
| 2 | 2026-08-24 14:20:04 | no_token | create | A | LM-GSZF | cancelled | 5500 |
| 3 | 2026-08-24 14:32:51 | no_request_id | create | B | LM-VGU2 | cancelled | – |
| 4 | 2026-08-24 14:32:51 | no_token | create | B | LM-VGU2 | cancelled | 8500 |
| 5 | 2026-08-24 15:21:05 | no_request_id | create | B | LM-4PF7 | cancelled | – |
| 6 | 2026-08-24 15:21:05 | no_token | create | B | LM-4PF7 | cancelled | 22900 |
| 7 | 2026-08-24 15:39:03 | no_request_id | edit | B | LM-4PF7 | cancelled | – |
| 8 | 2026-08-24 15:39:03 | no_token | edit | B | LM-4PF7 | cancelled | 22900 |
| 9 | 2026-08-24 15:47:44 | no_request_id | create | B | LM-NNZ3 | cancelled | – |
| 10 | 2026-08-24 15:47:44 | no_token | create | B | LM-NNZ3 | cancelled | 79500 |
| 11 | 2026-08-24 15:49:49 | no_request_id | create | B | LM-NQQM | cancelled | – |
| 12 | 2026-08-24 15:49:49 | no_token | create | B | LM-NQQM | cancelled | 19900 |
| 13 | 2026-08-24 20:49:36 | no_request_id | create | A | LM-QTEY | cancelled | – |
| 14 | 2026-08-24 20:49:36 | no_token | create | A | LM-QTEY | cancelled | 14500 |
| 15 | 2026-08-24 20:51:35 | no_request_id | edit | A | LM-QTEY | cancelled | – |
| 16 | 2026-08-24 20:51:35 | no_token | edit | A | LM-QTEY | cancelled | 14500 |
| 17 | 2026-08-26 18:46:05 | no_request_id | create | A | LM-WXWQ | cancelled | – |
| 18 | 2026-08-26 18:46:05 | no_token | create | A | LM-WXWQ | cancelled | 3900 |
| 19 | 2026-08-28 02:37:40 | no_request_id | create | A | LM-3YUE | cancelled | – |
| 20 | 2026-08-28 02:37:40 | no_token | create | A | LM-3YUE | cancelled | 4900 |
| 21 | 2026-08-30 22:00:11 | no_request_id | create | A | LM-RL6B | completed | – |
| 22 | 2026-08-30 22:00:11 | no_token | create | A | LM-RL6B | completed | 6500 |
| 27 | 2026-09-02 00:39:56 | no_request_id | create | A | LM-Q97B | cancelled | – |
| 28 | 2026-09-02 00:39:56 | no_token | create | A | LM-Q97B | cancelled | 17900 |
| 29 | 2026-09-02 00:42:42 | no_request_id | edit | A | LM-Q97B | cancelled | – |
| 30 | 2026-09-02 00:42:42 | no_token | edit | A | LM-Q97B | cancelled | 20900 |
| 31 | 2026-09-02 00:49:00 | no_token | create | A | LM-OPST | cancelled | 10000 |
| 32 | 2026-09-03 01:44:54 | no_request_id | create | A | LM-2NDX | completed | – |
| 33 | 2026-09-03 01:44:54 | no_token | create | A | LM-2NDX | completed | 15900 |

Identity legend (sha256 of the auth user id, as stamped by the RPC):
A = `377946f64909e5cdc2a5e6bd802a327f994351ef90df34ac503811e582604232`,
B = `5e643aa1d0173aac5e86eeba4f2b228365d74fdbd00e4ab7d11e519f73736265`.
Ids 23–26 do not exist (see G4).

E7 — verified rows, browser vs server cents: create 38 rows, **38 matching,
0 mismatching, 0 NULL**; edit 25 rows, **25 matching, 0 mismatching, 0
NULL**.

E8 — verified mismatches, row by row: **zero rows.**

E9 — `quote_acceptances` (consumed tokens): create / `client_observe` 38
rows, 38 `client_cents = final_cents`, 0 mismatching (2026-09-04 05:26:47 →
2026-10-30 09:44:19); edit / `client_observe` 25 rows, 25 matching, 0
mismatching (2026-09-04 14:53:01 → 2026-10-30 09:57:55). One acceptance per
verified write (63 = 63); no `server_quote` authority exists yet.

E10 — bookings created inside the window, per day: every row
`client_observe` + `canonical`, `with_duration = 0` on every day —
2026-09-04: 6, 09-05: 2, 09-06: 1, 09-07: 3, 09-09: 4, 09-10: 8, 09-11: 6,
09-12: 1, 09-13: 1, 09-16: 1, 09-17: 1, 09-20: 1, 10-26: 1, 10-27: 1,
10-30: 1 — **38 bookings = the 38 verified creates.**

E11 — bookings authority, full history (163 rows):

| price_authority | route_authority | rows | first (UTC) | last (UTC) |
|---|---|---|---|---|
| backfill | legacy_text | 113 | 2026-08-01 17:36:09 | 2026-08-23 18:43:21 |
| client_legacy | legacy_text | 12 | 2026-08-24 14:20:04 | 2026-09-03 01:44:54 |
| client_observe | canonical | 38 | 2026-09-04 05:26:47 | 2026-10-30 09:44:19 |

**No `client_legacy` row after the flag release; no `server_quote` row at
all** (correct before enforce). The last `client_legacy` booking is the last
`off`-mode ledger row (same instant).

E12 — bookings in the window with no writer trace: **zero rows.**

E13 — the named bookings → identity hashes:

| trip | created (UTC) | status | authority | version | identity |
|---|---|---|---|---|---|
| LM-EFFA | 2026-10-26 17:22:12 | pending | client_observe | 1 | `841341d6664079693e34181e951cf90eaf263fa0e0e56e77a151e39f4943e517` |
| LM-SR92 | 2026-10-27 21:06:42 | cancelled | client_observe | 1 | `7280ec043965047820f4b7170d9eaeae878abd58d75478a7e2f477e5e90fadb7` |
| LM-ZZDJ | 2026-10-30 09:44:19 | cancelled | client_observe | 6 | `7280ec043965047820f4b7170d9eaeae878abd58d75478a7e2f477e5e90fadb7` |

LM-SR92 and LM-ZZDJ share one identity (the controlled-booking account).
LM-EFFA belongs to a DIFFERENT identity (see §5, note on LM-EFFA).

E14 — aggregate profile of the identities that carry non-verified rows:

| identity | customer rows | bookings | completed | cancelled | first booking | last booking | ledger rows | verified |
|---|---|---|---|---|---|---|---|---|
| A (`377946f6…`) | 1 | 78 | 26 | 50 | 2026-08-02 19:43 | 2026-09-12 18:21 | 70 | 51 |
| B (`5e643aa1…`) | 1 | 15 | 7 | 5 | 2026-08-03 08:55 | 2026-08-24 15:49 | 10 | 0 |

Guard cross-check:

G1 — functions (public schema):

| function | SECURITY DEFINER | body sha256 | service_role | anon | authenticated |
|---|---|---|---|---|---|
| accept_optional_edit(uuid,uuid,uuid,text,uuid,integer,jsonb) | yes | `43e77f05…` | EXECUTE | no | no |
| accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb) | yes | **`bed377560252619862bcad768a2d5615496aca0f3d5016c4731d5afad651b6e1`** | EXECUTE | no | no |
| accept_quote_edit(uuid,uuid,uuid,text,uuid,integer,text,uuid,text,jsonb,numeric,text,text,text,jsonb) | yes | **`0acb70791a784c9569ab062dba2c04e17be380f9e0a9ed28361f1f5dea2d5ed8`** | EXECUTE | no | no |
| bookings_guard() | yes | `7a9d3606…` | no | no | no |
| linkmia_pickup_is_future(timestamptz,timestamptz) | no (invoker) | `3ca3d6af…` | no | no | no |
| pricing_state_guard() | no | `67fcfc4b…` | no | no | no |
| set_pricing_mode(text,text) | yes | `ccdae2b1…` | EXECUTE | no | no |

The two writer fingerprints equal the 019 "INSTALLS (target)" values in
`docs/PRT-MIGRATION-RUNBOOK.md` — the installed pair is `target_019`. The
helper's restricted ACL (no PUBLIC/anon/authenticated/service_role EXECUTE)
matches the PR-T runbook.

G2 — triggers: `bookings_guard_trg` (bookings), `pricing_state_guard_trg`,
`pricing_state_truncate_guard_trg` (pricing_state),
`pricing_state_audit_guard_trg`, `pricing_state_audit_truncate_guard_trg`
(pricing_state_audit) — all five present and enabled (`O`).

G3 — constraints: `bookings_assignment_epoch_check`,
`bookings_price_authority_check`, `bookings_price_cents_equal_check`,
`bookings_price_nonnegative_check`, `bookings_route_authority_check`,
`bookings_route_identity_check` (all CHECK) and the unique index
`bookings_one_active_per_customer` present; `quote_verifications_verdict_check`
present with **16 verdict literals** (not widened).

G4 — identity sequences: `pricing_state_audit_id_seq` last_value **1** (one
audit row — the 017 smoke's `setval` restore held); `quote_verifications_id_seq`
last_value **98** against 92 rows. Six ids were consumed by transactions that
did not commit; ids 23–26 fall between 2026-08-30 and 2026-09-02, which
matches migration 018's rollback-contained smoke on 2026-09-01 (its own
comment says it may consume sequence values without rows), and the other two
are consistent with migration 019's smoke on 2026-09-09. That attribution is
an inference from the dates, not a verified fact (the exact id positions
above 33 were not listed — outside the authorized query set).

G5 — activity snapshot at 2026-10-30 15:16:18 UTC: **1** nonterminal booking,
**163** bookings in total (= E11's sum).

G6 — Supabase `list_migrations`: **empty**, as Codex reported. The catalog
above is the installation evidence.

## 5. Classification of every non-verified row

Method, fixed before the data was read:

1. Rows with `mode = 'off'` (before 2026-09-03 04:56 UTC): expected off-mode
   background from the PR #76 writer swap (flag false → `no_token`; no
   envelope on the legacy fare POST → `no_request_id`). EXPLAINED by period.
2. Rows with `mode = 'observe'` between 2026-09-03 and the PR #88 merge
   instant: the flag was still false → `no_token` is the only possible
   verdict. EXPLAINED by period.
3. Rows after the merge instant that belong to a SPECIFIC controlled
   operation — matched by `booking_id` / trip code (LM-SR92, LM-ZZDJ, and any
   other booking Andres names as controlled) or by the operation id of a
   controlled create — → KNOWN TEST TRAFFIC. An identity match is NOT
   enough: an account that made controlled bookings can also make real ones,
   so E13's hashes only locate candidates; they never classify a row.
4. Rows after the merge instant that are `no_token` and fall inside the
   stale-tab drain → EXPLAINED as drain ONLY if the same identity also
   produced a later `verified` row; else UNEXPLAINED.
5. Benign registry outcomes traceable to a verified lane
   (`replay_idempotent`, `would_quote_consumed`, `edit_conflict`,
   `active_conflict`, `replay_context_mismatch`) → EXPLAINED as contract
   behavior, listed anyway.
6. Everything else → UNEXPLAINED. One UNEXPLAINED row fails the rule.

Result (E6, 29 rows):

| class | rows | ids | reason |
|---|---|---|---|
| EXPLAINED by period — rule 1 (`off` mode, 2026-08-24 14:20 → 2026-09-03 01:44 UTC) | 29 | 1–22, 27–33 | Every row predates the observe switch (2026-09-03 04:56 UTC) and the flag release; each `no_token` row is the legacy fare POST of the flag-false browser, and each `no_request_id` row is the same write's missing-envelope instrument (14 of the 15 writes carry the pair; the 15th, LM-OPST at 2026-09-02 00:49 UTC, carried an operationId but no token — still pre-window `off`). |
| Rule 2 (`observe` + `no_token` before the release) | 0 | – | No write happened in that gap. |
| Rule 3 (known test traffic inside the window) | 0 | – | No non-verified row exists inside the window, so none needed classifying by booking or operation. |
| Rule 4 (stale-tab drain) | 0 | – | No `no_token` row after the release at all. |
| Rule 5 (benign registry outcomes) | 0 | – | None ever written. |
| **UNEXPLAINED** | **0** | – | – |

Observations that do not change the classification:

- Identity A produced 19 of the 29 rows and is the dominant booking identity
  of August–September (78 lifetime bookings, 26 completed, 50 cancelled, 51
  verified rows; last booking 2026-09-12). Identity B produced the other 10
  rows, all on 2026-08-24 between 10:32 and 11:49 EDT (the first 110 minutes
  after the PR #76 merge at 10:00 EDT) — four creates and one edit, every
  booking cancelled; its last booking is the last of those. Neither identity
  was mapped to a person; the classification does not need it.
- Two of the 29 rows belong to COMPLETED rides (LM-RL6B, LM-2NDX): real
  legacy-priced rides from the off-mode period, stored as `client_legacy`
  exactly as designed.
- Note on LM-EFFA: the parent session listed it among the controlled
  bookings. The data cannot confirm the label either way: its identity
  differs from the LM-SR92/LM-ZZDJ account (which neither proves nor
  disproves a controlled booking — an identity is not a test marker, rule
  3), it is the one nonterminal (`pending`, `details_version 1`) booking in
  the table, and its single ledger row is `verified` with matching cents.
  Andres confirms what it is. The PASS is unaffected in every reading: rule
  3 classified zero rows because the window holds no non-verified rows, and
  LM-EFFA's only ledger row is verified.

## 6. Graduation verdict

**PASS at the ledger level — zero UNEXPLAINED non-verified rows in the
window (in fact zero non-verified rows of any kind since the flag release).**

Supporting facts, all from §4:

| Check | Expected | Observed |
|---|---|---|
| Non-verified rows in the window (E5/E6) | 0 unexplained | 0 of any kind |
| `no_token` / `no_request_id` / `verify_failed` in the window | 0 | 0 / 0 / 0 |
| Verified rows, browser vs server cents (E7/E8) | 0 mismatches | 63 rows, 63 matching, 0 mismatching, 0 NULL |
| Acceptance ledger cents (E9) | 0 mismatches | 63 rows, 63 matching |
| Window bookings' authority (E10) | all `client_observe` + `canonical`, no duration | 38 of 38; `with_duration` 0 |
| `client_legacy` after the release (E11) | 0 | 0 (last one 2026-09-03 01:44 UTC) |
| `server_quote` rows before enforce (E11) | 0 | 0 |
| Bookings without a writer trace in the window (E12) | 0 | 0 |
| `pricing_state` (E1/E2) | observe, NULL high-water mark, one audit row | observe, NULL, one row (`off → observe`, 2026-09-03) |
| Installed writer pair (G1) | `target_019` | `bed37756…` / `0acb7079…` = `target_019` |
| Guards, triggers, constraints, verdict CHECK (G1–G3) | present, enabled, 16 literals | all present; 16 |
| Migrations listing (G6) | empty (hand-run) | empty |

Limits of this verdict (what a clean ledger does and does not say):

- Volume is small: 38 bookings and 25 edits in 57 days, with only three
  bookings after 2026-09-20 (two of them controlled). The rule is about the
  absence of bad rows, which the data shows; it is not a statement about
  traffic breadth.
- No registry refusal path has ever fired in production: zero `expired`,
  `not_yet_valid`, replay, conflict or consumed rows. The browser's quiet
  re-quote, the 409 `requote` and 428 `reload` contracts therefore have NO
  production exercise — they are proven only by the executed suites. This is
  relevant to the enforce decision because enforce is the first mode in
  which those refusals carry money consequences.
- Observe-mode agreement (client cents = server cents on every write) shows
  the browser submitted what the server quoted; it does not show what the
  system does with a browser that submits something else. That is the
  altered-price proof in §8, still to be done.

## 7. What the enforce rung still needs, independent of this evidence

Even with a clean ledger, `enforce` is not a flip of one switch:

- The valve is one-way: `observe → enforce` sets `enforcement_started_at`
  and from then on only `enforce ↔ blocked` exist. `off`/`observe` are
  unreachable forever (`set_pricing_mode` raises on the high-water mark).
- After the high-water mark `bookings_guard` refuses every client-priced
  INSERT and every direct ride-intent UPDATE (price, locations, time,
  vehicle, passengers, bags, mode, duration). Any remaining manual-SQL
  operational habit that touches those columns stops working; lifecycle
  columns (status, driver, checkpoints, cancellation, release) keep working.
- A browser without a token gets 428 `quote_required` (reload); without an
  operationId 428 `outdated_client`; a tampered or mismatched token 409
  `quote_invalid` (quiet re-quote); an expired one 409 `quote_expired`.
- Emergency after enforce is `blocked` only — and `blocked` is narrower than
  "every booking write refused" (`017_quote_enforcement_foundation.sql`):
  `bookings_guard` refuses only INSERTs ("bookings are temporarily blocked",
  INSERT branch ≈ line 420); `accept_quote_create` and `accept_quote_edit`
  return outcome `blocked`, which `lib/booking-writer.js` maps to HTTP 503
  with the WhatsApp copy ("Bookings are temporarily unavailable…");
  lifecycle UPDATEs (status, driver, cancel, release, checkpoints) PASS; and
  `accept_optional_edit` stays OPEN — 017's own smoke treats "blocked mode
  refused an optional-only edit" as a FAILURE (≈ lines 3479–3486) and the
  migration's comment reads "A pricing emergency blocks new and
  price-affecting operations, not contact/flight/note corrections". A
  missing operationId on that optional lane still answers `outdated_client`
  (428) in enforce and blocked. During an incident this is the distinction
  that matters: drivers keep working their rides and cancellations keep
  landing; only new bookings and priced edits stop.

## 8. The two options for proving an altered price or route identity is refused in `enforce`

Written, not executed. Both options start from the same fact: the RPC
trusts the endpoint's verdict. A token whose `finalCents` or intent was
altered never reaches the database as `verified` — Node's verifier refuses
it (`bad_signature` or `wrong_intent` → `verify_failed`). So "an altered
price cannot become an authoritative record" has a DATABASE half (in
`enforce`, money comes only from the verified projection; unverified
verdicts are refused before any write; legacy writers are fenced) and a
NODE half (the signature and keyed commitment reject the alteration). Each
option proves a different share of that. The most important enforce case is
the OTHER one: an UNALTERED valid token submitted with an altered BROWSER
amount does reach the database as `verified`, and in `enforce` the database
must ignore the browser amount and store the token's `finalCents` — that is
the case both options lead with (A1/A2 in (a), the first two rows of (b)).

### Option (a) — rollback-contained SQL-editor smoke in production (017 runbook pattern)

Shape (design sketch; NOT runnable as written and NOT to be run without its
own review and Andres's explicit authorization):

```text
BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;
SET LOCAL idle_in_transaction_session_timeout = '30s';   -- belt: a dangling editor transaction cannot hold the lock
DO $graduation_smoke$
DECLARE  ...row counts captured first; both identity-sequence values READ for the record only, never reset...
BEGIN
  -- refuse unless the baseline is exactly observe / NULL high-water mark (B1)
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';             -- application privilege ceiling, as the 017 runbook smoke
    PERFORM set_pricing_mode('enforce', 'graduation-smoke-2026-10');   -- the ONLY sanctioned way to reach enforce
    -- synthetic auth uuid + synthetic customer (no auth.users row needed; 017 precedent), pickup 2 days out
    -- A1  verified create, p_client_price <> payload.finalCents  -> booking.price_cents = finalCents, price_authority = 'server_quote',
    --                                                             acceptance.client_cents IS NULL, telemetry client_cents <> server_cents recorded
    -- A2  verified edit, same assertion on the UPDATE lane
    -- A3  no_token create / edit                                 -> outcome quote_required, rejected_no_token row, ZERO booking rows
    -- A4  verify_failed create / edit (digest only)              -> outcome quote_invalid, rejected_invalid row, ZERO booking rows
    -- A5  verified create with NULL operation id                 -> outcome outdated_client, no_request_id row, nothing consumed
    -- A6  verified create whose payload.vehicle <> p_vehicle_key -> RAISE (canonical airport/vehicle context invalid)
    -- A7  verified create whose booking pickup <> payload.pickupAtMs -> RAISE (pickup does not match)
    -- A8  authentic-but-expired payload                          -> outcome quote_expired, expired row, nothing consumed
    -- A9  direct INSERT INTO bookings                            -> RAISE 'client-priced booking writes are closed after enforcement'
    -- A10 direct UPDATE of price/pickup_location on the smoke row -> RAISE 'ride-intent columns are closed'
    -- A11 lifecycle UPDATE (status/driver/cancel) on the smoke row -> passes
    -- A12 set_pricing_mode('observe')                            -> RAISE 'invalid pricing mode transition enforce -> observe' (valve)
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION USING ERRCODE = 'ZZ0GR', MESSAGE = 'GRADUATION_SMOKE_ROLLBACK';   -- sentinel: inner rollback of EVERY mutation
  EXCEPTION WHEN SQLSTATE 'ZZ0GR' THEN NULL;
           WHEN OTHERS THEN EXECUTE 'RESET ROLE'; RAISE;
  END;
  -- NO setval here: the inner rollback already RELEASED the locks, so a concurrent writer may have advanced
  -- quote_verifications_id_seq; a reset would move it BACKWARDS (see "What makes it work"). Gaps are harmless.
  -- residue proof INSIDE the block: row counts equal, mode = 'observe' AND enforcement_started_at IS NULL, no smoke rows
END $graduation_smoke$;
ROLLBACK;                                                 -- second belt (017 runbook: never replace with COMMIT)
SELECT ...residue grid: smoke trip ids 0, smoke customer 0, mode, enforcement_started_at, both sequences READ (gaps recorded, nothing reset)...;
```

What makes it work:

- `set_pricing_mode` is `SECURITY DEFINER`, executable by `service_role`,
  and is the only DML path into `pricing_state` (the guard triggers refuse
  everything else, TRUNCATE included). Inside the transaction the mode row
  reads `enforce` with `enforcement_started_at = now()`, so every
  post-high-water fence in `bookings_guard` and both writers is genuinely
  live for the assertions.
- Row-level containment is double: the sentinel exception rolls back the
  inner block (017's `ZZ017` pattern), and the outer `ROLLBACK` discards
  the transaction. The `pricing_state`/audit changes are ordinary row
  versions and roll back with it; the migration-017 smoke proved exactly
  this on this database.
- The two `BIGINT GENERATED ALWAYS AS IDENTITY` sequences
  (`pricing_state_audit_id_seq`, `quote_verifications_id_seq`) are the only
  non-transactional state the smoke touches, and the smoke must NOT reset
  them. Reason: the sentinel exception rolls back the inner block, which
  RELEASES the `FOR UPDATE`/`FOR SHARE` locks taken inside it; between that
  rollback and any later `setval`, concurrent production writers (every
  create/edit writes a telemetry row) can advance
  `quote_verifications_id_seq`, so a `setval` back to the captured value
  would move the sequence BACKWARDS and a later insert would fail with a
  duplicate key on the identity column — and because sequence changes are
  non-transactional, the outer `ROLLBACK` would not undo it. Identity gaps
  are harmless: the residue grid READS the before/after values for the
  record and writes nothing; never reset a sequence. Migration 017's own
  smoke did reset them, but inside an install transaction holding NOWAIT
  exclusive table locks from the top level; option (a) has no such fence and
  must not copy that step. Everything else keyed by UUID leaves nothing.
- No Node code runs, so no Telegram, no push, no Google call, no envelope.

What can break it (and the residue risk):

- **The lock is global.** `set_pricing_mode` takes `FOR UPDATE` on the
  singleton; `bookings_guard` (every INSERT/UPDATE on `bookings`: driver
  taps, cancels, releases, watchdog stamps, flight-facts paths) and both
  writers take `FOR SHARE`. From the mode call until `ROLLBACK`, every
  booking write in production waits. The script must be one paste with no
  interactive step, run in a declared quiet window with the watchdog
  disabled (`WATCHDOG_DISABLED=1` + redeploy, 017 runbook), and
  `idle_in_transaction_session_timeout` set so an editor session that stops
  mid-script cannot hold the lock indefinitely.
- **The valve is the failure mode being rehearsed.** If the transaction
  COMMITS (an edited script, a `COMMIT` pasted in place of `ROLLBACK`, an
  editor that splits the paste), production is in `enforce` at an unplanned
  instant with the high-water mark set and `observe` unreachable by design.
  The only ways back are owner-level DDL improvisation (the runbook forbids
  it) or PITR. The smoke's synthetic customer/booking would also commit.
  This is irreversible by construction and is the single reason option (a)
  must never be run casually.
- **An error mid-script** leaves the editor's transaction open in aborted
  state until `ROLLBACK` is issued in that session (017 runbook) — the
  timeout above bounds the lock hold; the aborted transaction itself writes
  nothing.
- Sequence gaps whenever the smoke runs at all (its own inserts advance
  `quote_verifications_id_seq` and `pricing_state_audit_id_seq`; the
  rollback does not give the values back). Harmless; record the before and
  after values and never "repair" them.
- Baseline drift: the smoke must refuse to run unless B1 shows
  `observe`/NULL and A2 shows `target_019`, like the 018/019 smokes did.

What it proves: the DATABASE half against the installed production bodies
and catalog (A1–A12 above). What it does NOT prove: that an altered token or
intent is refused at the HTTP boundary (Node's verifier and the 428/409
mapping), nor the browser's quiet re-quote/reload behaviour, nor the live
signing-key configuration under enforce. It also adds little that the
2026-08-23 production run of 017's own enforce smoke and today's PGlite
matrix on the 019 bodies have not already shown.

### Option (b) — an isolated environment (Supabase preview branch or second project + preview-scoped secrets)

Setup facts checked today:

- The `linkmia` project (`qvtqqggtpxesfcmpftej`, org `gnmvfbnhzskpklutlyhy`)
  has no branches; branching is a Pro-plan feature (the org is paid). MCP
  `get_cost`: a branch is **$0.01344/hour** (≈ $0.32/day, ≈ $9.68/month if
  left running; preview branches auto-pause), a second project is
  **$10/month**.
- Supabase docs (read today): a branch gets "a full copy of your database
  schema (without any production data)"; dashboard branching is public
  alpha; "if you have run migrations on main, new branches will be created
  from existing migrations instead of a full schema dump" — LinkMia's
  migration history is EMPTY (hand-run), so a branch would come from a full
  schema dump. Custom roles created through the dashboard are not captured
  (LinkMia uses only platform roles). The G1–G3 grids run on the branch
  verify that the guards, writers (019 fingerprints) and triggers arrived.
- Because data is not copied, the `pricing_state` SINGLETON ROW is absent on
  a branch, and the guard trigger refuses a plain INSERT. Seeding it is an
  owner step in the branch's SQL editor: set the transaction-local
  `linkmia.pricing_state_writer = 'on'` GUC and INSERT `(TRUE,'off')` — the
  same INSERT 017 ran at creation — then `set_pricing_mode('observe')`.
  ORDER MATTERS from here: while the branch is in `observe` (no high-water
  mark), seed the pre-flight's probe booking, the synthetic
  `customers`/`drivers`/`hosts` rows and the branch's OWN auth user (the
  branch has its own Auth; no production person is copied), run the
  isolation pre-flight (ii) below, and ONLY THEN
  `set_pricing_mode('enforce')`. The reason is 017's `bookings_guard`: once
  `enforcement_started_at` is set, its legacy-writer INSERT path raises
  "client-priced booking writes are closed after enforcement (use the
  accept_quote RPCs)" (`017_quote_enforcement_foundation.sql` ≈ lines
  453–456), so a probe booking inserted by direct SQL AFTER the flip fails
  — and after the flip no direct INSERT works on the branch at all: every
  later synthetic booking must come through the RPC lanes, which is the
  proof itself. The valve's one-way nature is otherwise harmless on a
  disposable branch.
- A second project instead needs the chain 001 → 021 run by hand in order,
  which `tests/r1-migration-chain.test.js` and `tests/prt-pickup-integrity`
  already execute on real PostgreSQL (017 with an empty manifest; 019 only
  accepts the reviewed 018 pair, so paste from a UTF-8 editor as the PR-T
  runbook says). More deterministic, no alpha feature, $10/month.
- Netlify: Codex's inventory shows the deploy-preview context today carries
  the PRODUCTION `SUPABASE_SERVICE_KEY` and the `all`-context
  `SUPABASE_URL`, and lacks `QUOTE_SIGNING_CURRENT_SECRET`,
  `GOOGLE_ROUTES_API_KEY`, `GOOGLE_PLACES_SERVER_API_KEY`. Isolation means
  deploy-preview-scoped overrides of `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_KEY` to the branch's values plus a TEST-ONLY
  `QUOTE_SIGNING_CURRENT_ID/SECRET` (32+ bytes, never the production
  secret). Google keys are optional: tokens can be minted offline with the
  repo's own `signQuoteToken` under the test secret (what
  `tests/booking-writer.test.js` does), or the restricted server keys can be
  set for the preview context at normal per-call cost under the
  project-wide quota caps.
- Browser caveat: `supabase.js` hardcodes the production URL/anon key, so a
  preview's PAGE would still sign in against production Auth and the
  isolated functions would reject those JWTs. Two ways: drive the preview's
  `/api/create-booking` and `/api/update-pending-booking` directly with a
  session JWT from the branch's Auth (no code change; enough for the
  altered-price proof), or add a build-time substitution of `supabase.js`
  for previews (a reviewed code change) for a full browser-level pass.

Isolation pre-flight — the proof's database, auth and notification targets
must be PROVEN to be the branch before the first write reaches the preview,
not assumed from the variable names:

(i) **One named preview.** Open a dedicated DRAFT PR for the proof (no code
change is needed beyond, optionally, the `supabase.js` substitution) and use
ONLY its Deploy Preview, `deploy-preview-<n>--i-love-miami.netlify.app`,
recording the deploy permalink of the exact build. Nothing is sent to any
other preview or to production.

(ii) **Database and auth target probe (read-only on both sides; the branch
must still be in `observe`).** On the branch — BEFORE
`set_pricing_mode('enforce')`, see the setup order above — seed one
synthetic legacy-guest pending booking (`customer_id` NULL, a fresh UUID,
synthetic text, a finite price) through the branch's SQL editor; in
`observe` the guard stamps it `client_legacy`, after the flip the same
INSERT is refused. Then
`GET <preview>/api/booking-status?id=<that uuid>` must answer 200 with
`pending`, and the same path on production (`https://linkmia.com`) must
answer 404 — the preview's deployed functions read the BRANCH
(`booking-status.js` resolves bare-UUID guest bookings, PR 1A). For auth,
create one branch-only auth user, sign it in against the branch's Auth for
a session JWT, and call `GET <preview>/api/profile` with it: 200 on the
preview, and the same JWT against production's `/api/profile` must be 401
— the preview verifies sessions against the branch, not production. Record
the four status codes. Run E1 on both databases: production must read
`observe`/NULL before and after the proof. Any other outcome stops the
proof before any write. Only after this probe passes does the branch move
to `enforce` (`set_pricing_mode('enforce')` in the branch's SQL editor).

(iii) **Notification isolation.** Swapping the database credentials alone
does NOT isolate notifications. Paths verified in the repo (2026-10-30):
`create-booking.js` `sendDoorbell` and `update-pending-booking.js`
`sendUpdatedDoorbell` call the Telegram API DIRECTLY with
`TELEGRAM_BOT_TOKEN` + `ADMIN_TELEGRAM_CHAT_ID` from the all-context (each
skips only when either variable is unset); `cancel-booking.js` and the
driver lifecycle route through `lib/dispatch.js` / `lib/notify.js`, whose
push path uses `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`PUSH_DISABLED` and whose Telegram fallback uses the same two Telegram
variables; `update-booking-status.js` also sends Telegram directly. Required
deploy-preview-context overrides, in place BEFORE the proof build: a TEST
bot token and a TEST chat id for `TELEGRAM_BOT_TOKEN` /
`ADMIN_TELEGRAM_CHAT_ID` (a test destination rather than unsetting them, so
the paths execute and land somewhere observable), plus `PUSH_DISABLED=1`
(the branch copies no `push_subscriptions` rows, so no device is reachable,
but the fallback must then land in the TEST chat, never the admin chat).
Verify by reading the test chat after the first create. The scheduled
watchdog needs no override: `netlify.toml` records that deploy previews
never run schedules, so the branch's outbox is simply never drained and
production's watchdog keeps reading production. Settled 2026-10-31 (Codex's
read-only review; re-read by this session): `executeTelegram` in
`lib/dispatch.js` returns before any send when `TELEGRAM_BOT_TOKEN` is
unset (line 285, "config gap: leave for next cycle") and again when no
destination resolves (`if (!chatId) return` — admin chat id unset, or a
driver chat unresolved), leaving the event pending for a cycle that no
preview runs — so unsetting both variables would ALSO be safe for the
dispatcher path; the test destination stays the choice because an
observable landing beats silence. Netlify's scheduled-functions
documentation corroborates netlify.toml: schedules fire only for published
deploys, and "Deploy Previews and branch deploys won't trigger them
automatically" (Limitations; a manual "Run now" exists and is not used in
the proof).

(iv) **Blast radius and restore.** Deploy-preview-context variables are
shared by EVERY Deploy Preview of the site — the route-identity and
terminal-motion previews included — and Netlify fixes a deploy's variable
values AT DEPLOY TIME: each deploy "uses the environment variable values
that were set at the time of deployment", and updated values reach a deploy
only through a new deploy (Netlify docs, Functions → Environment variables,
"Overrides and limitations"; settled by Codex's 2026-10-31 review and
re-read by this session). Two consequences. A preview deployed BEFORE the
window keeps production's values and is untouched. A preview BUILT INSIDE
the window takes the branch values, writes to the branch, notifies the test
chat, proves nothing about production — and KEEPS pointing at the branch
after the overrides are restored, until it is redeployed; the moment the
branch is deleted, that preview's functions break. The operator therefore
declares one of two paths before the window opens:

- EITHER reserve the window for exactly ONE preview build — the proof
  preview's — with no push to any other open PR and no manual redeploy or
  retry of any other preview while the overrides are in place;
- OR, before deleting the branch, REDEPLOY EVERY preview whose deploy id
  was recorded inside the window and re-run probe (ii) inverted on EACH of
  them — `booking-status` for the branch-only UUID answers 404 and the
  branch JWT is refused.

In both paths: record the window (UTC start and end, the exact variable
names changed, the deploy ids of every preview built inside it); RESTORE by
deleting the deploy-preview-scoped overrides (or putting back the prior
values); redeploy the proof preview and verify probe (ii) inverted on it;
and delete the branch and the test signing secret ONLY after that
per-preview verification is complete.

Proof matrix in `enforce` on the isolated environment (each case a real HTTP
call through the deployed function into the real database). The first two
rows are the headline: a VALID token with ONLY the browser-submitted amount
altered, on both lanes. The later rows alter the token itself (signature or
keyed commitment) and are separate cases:

| Case | Expected |
|---|---|
| **Valid token, matching intent and operationId, ONLY the browser-submitted price altered — create lane (`/api/create-booking` → `accept_quote_create`)** | **200 `created`; `bookings.price_cents` = the token's `finalCents` regardless of the altered browser amount; `price_authority = 'server_quote'`; acceptance row `client_cents IS NULL`; telemetry `verified` row records `client_cents <> server_cents` (the assertions of option (a)'s A1). This is THE enforce case: the browser's number stops mattering.** |
| **Same, edit lane (`/api/update-pending-booking` → `accept_quote_edit`)** | **200 `updated` with the new `detailsVersion`; the row's `price_cents` = `finalCents`, `price_authority = 'server_quote'`; acceptance `client_cents IS NULL`; telemetry `client_cents <> server_cents` (option (a)'s A2).** |
| Contrast, not a proof step — the same request in today's `observe` mode | the BROWSER amount is stored (`client_observe`) and the mismatch lands only in telemetry — exactly what `enforce` changes |
| Valid token, browser amount equal to `finalCents` (the ordinary case) | 200 `created`; `bookings.price_authority = 'server_quote'`, `price_cents = finalCents`; acceptance `client_cents IS NULL`; telemetry `verified` |
| Same token, `finalCents` altered in the payload (re-encoded) | Node `bad_signature` → `verify_failed` → RPC `rejected_invalid` → **409 `quote_invalid`**, zero rows |
| Same token, request `placeId` / `airportCode` / pickup / passengers altered | Node `wrong_intent` (keyed commitment) → **409 `quote_invalid`**, zero rows |
| Same quote, sibling vehicle token with a different `vehicleKey` echoed | `wrong_vehicle` → **409 `quote_invalid`** |
| No token | RPC `rejected_no_token` → **428 `quote_required`**, zero rows |
| No `operationId` | **428 `outdated_client`** |
| Expired token | **409 `quote_expired`**, nothing consumed |
| Token replayed after success | `idempotent` / `quote_consumed`, no second booking |
| Edit lane (`/api/update-pending-booking`) | the same matrix against `accept_quote_edit`, incl. `edit_stale` version CAS |
| Direct SQL INSERT/UPDATE of price on the branch | refused by `bookings_guard` after the high-water mark |
| Browser (if the substitution is built) | quiet re-quote on 409, reload on 428, the "Updating price…" copy — never "refused" |

What (b) proves that (a) cannot: the whole path — Node verifier, HTTP
contract, envelope/retry, and optionally the browser — under `enforce`,
with the real deployed function and a real database, at zero production
risk PROVIDED the isolation pre-flight (i)–(iv) passed before the first
write and the restore step is verified afterwards; until it passes, a
preview is not isolated (Codex's inventory shows today's deploy-preview
context pointing at production's database). It also rehearses the flip
itself (`set_pricing_mode('enforce')`), the 428 reload path and the
`blocked` emergency without touching the production valve. What it does not prove: production's own catalog and
secrets (the G-grids on production and the 401 probe cover the catalog and
the config presence).

Setup cost (estimate): branch creation + G1–G3 verification ~30 min; singleton
seed + synthetic actors + branch auth user ~30 min; Netlify preview-context
overrides ~30 min (also closes Codex's "previews write to production"
finding for the duration); token-minting script reusing `signQuoteToken`
~1 h; isolation pre-flight (i)–(iii) ~30 min and the restore check ~15 min
per preview built in the window (one, if the window is reserved);
running the matrix and capturing evidence ~2–3 h; a second project instead
of a branch adds the hand-run chain (~2 h with the preflight grids).
Data/secret handling: no production data leaves production; a test-only
signing secret distinct from production, rotated/deleted afterwards; the
branch's service key lives only in the deploy-preview context; delete the
branch (or project) once the evidence is captured; production secrets are
never pasted into any preview context.

### Recommendation

Do **(b)** as the proof of record, preferring a preview branch (cheap,
disposable, schema from production) and falling back to a second project if
the branch's catalog does not pass G1–G3. It is the only option that
exercises the place where an altered price is actually refused (the Node
verifier and keyed commitment) together with the database authority rules,
and — once the isolation pre-flight in (b) passes — it carries no production
risk.

Treat **(a)** as optional and late: if used at all, run it as the final
rehearsal in the SAME quiet window as the real enforce flip, because its one
irreversible failure (an accidental commit) is exactly the action being
rehearsed, and its database-half evidence already exists twice (017's
production run on 2026-08-23; today's PGlite matrix on the 019 bodies).

Either way: `enforce` itself remains Andres's separate decision. This
document, a clean graduation ledger, and a passed (b) matrix are inputs to
that decision, not the decision.

## 9. What was NOT verified here

- No altered-price write was attempted anywhere against production, by
  design of this task; the refusal of altered prices is not proven by this
  document (see §8).
- The identities behind hashes A and B were not mapped to people and do not
  need to be for the rule; the real-versus-test split of the 63 verified
  rows was likewise not established (the rule does not depend on it).
- The attribution of the six unused `quote_verifications` ids to the 018 and
  019 migration smokes is an inference from dates; listing the exact ids was
  outside the authorized query set.
- LM-EFFA's nature (real or controlled) is unresolved; it affects nothing in
  the rule.
- The Supabase branching claims (schema dump when the migration history is
  empty; data not copied) are the docs' statements as read today, not
  observed on this project — the G-grids on a created branch are the check.
- The HTTP status mapping was read from `lib/booking-writer.js` and the
  mocked suites; it was not exercised against a deployed function in
  `enforce` (that is option (b)).
- Supabase SQL-editor transaction handling on mid-script errors is quoted
  from the 017 runbook's own instruction, not re-tested.
- Option (b) has not been run; nothing in §8(b) is observed behaviour of a
  branch or a preview.

Settled since revision 2 by Codex's 2026-10-31 read-only review (each item
re-read by this session the same day; all three were "not verified" in
revision 2):

- Netlify applies environment variables at deploy time: each deploy uses
  the values set when it was deployed and picks up changes only through a
  new deploy (Netlify docs, Functions → Environment variables, "Overrides
  and limitations"). Consequence recorded in §8(b) (iv): every preview built
  inside the override window keeps pointing at the branch until it is
  redeployed.
- Deploy Previews and branch deploys do not trigger scheduled functions
  automatically; schedules fire only for published deploys (Netlify docs,
  Functions → Scheduled functions, "Limitations"). The netlify.toml
  statement is corroborated.
- The Telegram dispatcher (`lib/dispatch.js` `executeTelegram`) returns
  before any send when `TELEGRAM_BOT_TOKEN` is unset (line 285) and when no
  destination resolves (`if (!chatId) return`); unsetting would be safe for
  that path, and option (b) still overrides to a test destination so the
  landing is observable.
- The §3 statements were run through the MCP as single `SELECT`s; the
  `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;` wrapping is for SQL-editor
  reruns and was not needed for the MCP path.

## 10. Timeline anchors used for classification (git merge instants, EDT)

| Instant | Event |
|---|---|
| 2026-08-22 15:32 | PR #74 — migration 017 code on main |
| 2026-08-23 | migration 017 run in production (includes the rollback-contained enforce smoke) |
| 2026-08-24 10:00 | PR #76 — writer swap (first `quote_verifications` rows possible; `no_token` + `no_request_id` in `off`) |
| 2026-08-25 09:29 | PR #77 — envelope (`operationId` inside the body) |
| 2026-09-01 | migration 018 run (R1) |
| 2026-09-03 | `set_pricing_mode('observe','andres')` (audit id 1) |
| 2026-09-04 00:42:49 | PR #88 — browser flag true (WINDOW START) |
| 2026-09-09 | PR #93/#94 + migration 019 run; live smoke (test account; elapsed create/edit refused, future create/edit verified, cancel) |
| 2026-09-10 | PR #92/#96/#97 — review card / Manage ride sheet |
| 2026-09-30 | PR #116 — migration 020 (explicit service_role grants) |
| 2026-10-05 | PR #119 — flight facts (migration 021) |
| 2026-10-27 | PR #120/#121 — curated terminals; controlled booking LM-SR92 |
| 2026-10-30 | Codex production audit; controlled booking LM-ZZDJ (1 create + 5 edits, all `verified`, cents matching; accepted, cancelled) |
