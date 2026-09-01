# Migration 018 (R1) rollout and emergency runbook

This document is procedure, not authorization. Migration 018 remains unrun
until Andres explicitly approves executing the checksum-matched SQL artifact,
separately from having approved its authoring. Address plan v3's ordered
prerequisite R1 is the governing contract; Codex review is required before
either approval.

## What 018 changes, in one paragraph

`accept_quote_create` and `accept_quote_edit` are replaced IN PLACE (identical
signatures — no PostgreSQL overload; ACLs, ownership, SECURITY DEFINER and
search_path are preserved by `CREATE OR REPLACE`). After it runs: a verified
consumption no longer requires `duration_minutes`; provider duration is never
persisted in any pricing mode (create writes NULL, edit actively clears the
row it touches); and `quote_acceptances.payload_projection` becomes a
fail-closed allowlist that excludes `routeQuality`. No table, column, index,
constraint, trigger, grant or RLS change. `accept_optional_edit` untouched.

## Ordering relative to the code deploy

The code changes (writers stop forwarding duration; the operation-status
endpoint; the envelope split) and the SQL are INDEPENDENTLY SAFE in either
order while `pricing_state.mode = 'off'`:

- code first, SQL later: the old SQL still tolerates a missing duration on
  every non-verified write — and no client can PRESENT a token while
  `SERVER_QUOTE_ENABLED` is false and quote-ride is kill-switched, so no
  verified write can occur in the gap (a hypothetical one would fail closed
  against 017's duration requirement, which is the safe direction);
- SQL first, code later: the old code still forwards duration and the new SQL
  validates then discards it.

Preferred order regardless: MERGE THE CODE FIRST, verify production dark, then
run 018 in a quiet window. The operation-status endpoint only reads
`operation_receipts` (exists since 017), so it needs no SQL at all.

## Before the window

1. Confirm the reviewed commit; re-run the full suite (three timezones),
   `node tests/r1-route-content.test.js` (asserts the rollback file restores
   the 017 bodies BYTE-EXACTLY), and `node tests/r1-migration-chain.test.js`
   — the EXECUTED chain: real PostgreSQL applies schema+001..017, proves the
   017 duration requirement, proves FIVE mutants ABORT (revoked service_role
   EXECUTE; raw-passthrough projection; a dropped edit-projection key; a
   search_path stripped of `extensions`; a rollback over client-role
   EXECUTE), applies exact 018, proves NULL-duration behavior and the exact
   projections, applies the exact rollback, proves 017 behavior RETURNED,
   and re-applies 018 in-session.
2. Compute and record `shasum -a 256` of both
   `database/migrations/018_r1_route_content_non_retention.sql` and
   `018_r1_rollback.sql`. The artifact pasted into the SQL editor must match.
3. Read-only preflight in the Supabase SQL editor, one grid each
   (namespace-qualified and privilege-explicit — a bare-name probe can be
   satisfied or confused by a same-named function elsewhere):
   - ```sql
     SELECT n.nspname, p.proname, p.oid::regprocedure AS signature,
            p.prosecdef, p.proconfig,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('accept_quote_create','accept_quote_edit','accept_optional_edit');
     ```
     Expect exactly one row per name, `prosecdef = true`, search_path present,
     `sr_exec = true`, `anon_exec = false`, `auth_exec = false`.
   - `SELECT mode, enforcement_started_at FROM pricing_state;` Expect
     `off` and NULL. If mode is not `off`, STOP — this runbook assumes the
     dark phase.
   - `SELECT count(*) FROM quote_acceptances;` Expect 0 in the dark phase;
     a nonzero count is not a blocker but must be recorded (those rows keep
     their historical full projections until R2).
4. Confirm the notification watchdog's schedule and plan to re-verify it after
   the window (017 precedent).

## The window

1. Announce a quiet window to the second driver if any ride-day activity is
   plausible; no passenger-visible behavior changes either way.
2. Paste the checksum-matched 018 artifact into the SQL editor and run it.
   One transaction, three built-in gates, each aborting everything on RAISE:
   - a PRE-CAPTURE of both writers' exact namespace-qualified identities,
     owners and ACLs (regprocedure resolution is itself fail-closed);
   - VERIFICATION against that capture: same oid/owner/ACL, one function per
     name in `public`, SECURITY DEFINER + search_path, service_role EXECUTE
     held BEHAVIORALLY (has_function_privilege) and client roles still
     barred, the verified-duration requirement gone, the projection pair
     absent, the allowlist anchored AT the acceptance insert, and both
     per-function duration markers present;
   - a ROLLBACK-CONTAINED BEHAVIORAL SMOKE (017 discipline, sentinel ZZ018):
     real create/edit/verified-create/verified-edit through the replaced
     functions proving NULL duration and the exact projections (15 keys on
     create, 17 on edit, never routeQuality), then forced rollback and a
     row-count residue proof. No sequence rewind — see the note below.
3. Post-install grid, read-only: the namespace-qualified preflight query
   again — identical rows, `sr_exec` still true, client roles still false.
   NOTE: the smoke deliberately does NOT rewind `quote_verifications_id_seq`
   (a setval races concurrent inserts and is global/non-transactional), so it
   may consume a few sequence values without rows. Gaps are harmless and
   expected; do not "fix" them.

## Live smoke (dark, no paid calls)

1. From the production site, create one real test booking >24h out through
   the normal flow (mode `off`, no token): expect success, and
   `SELECT duration_minutes FROM bookings WHERE id = '<new id>';` → NULL.
2. Edit that booking (pending edit, same flow): expect success and
   duration_minutes still NULL; `details_version` incremented.
3. Cancel it (CANCEL, never DELETE — 017's FKs preserve receipts). Expect the
   usual two admin Telegram messages; the doorbell shows NO eta line (correct:
   there is no stored duration to display).
4. The doorbell for step 1's booking must contain NO eta line, and the trip
   page NO duration/ETA block, while the Google Maps attribution remains
   visible beside the route text (decoupled from duration).
5. Verify `/api/operation-status`. NOTE: the dark-phase NORMAL flow sends no
   operationId (the envelope machinery is quote-flag-gated), so this step is
   SCRIPTED: from the signed-in test account's browser console, POST
   /api/create-booking with a normal payload PLUS a fresh
   `operationId: crypto.randomUUID()` (the writer tolerates operation ids in
   mode `off` and records the receipt). Then POST /api/operation-status with
   that id and kind "create": expect settled:true with the booking id. Then
   with a different random UUID: expect `{"settled":false}`. Cancel the test
   ride as usual afterwards.
6. Verify the trip page for the test booking renders normally.

## Emergency rollback — sequenced (SQL-only rollback is incompatible with the R1 code)

Restoring the 017 bodies makes a verified consumption REQUIRE a duration —
but the R1 endpoints no longer send one. A cached or manually token-bearing
request could therefore 500 against restored SQL even in mode `off`. The
rollback is a SEQUENCE, each step separately and explicitly authorized by
Andres in Claude's chat:

1. HOLD DARK: confirm `QUOTE_SERVICE_DISABLED=1` and
   `SERVER_QUOTE_ENABLED` false (they should already be — this step is
   verification, not change), so no new tokens can be issued while rolling
   back.
2. CODE FIRST: deploy the pre-R1 code (revert the R1 PR on main → Netlify
   deploy). This restores endpoints that forward duration and a browser that
   sends it. Verify the deploy is live and drain in-flight requests
   (Netlify functions are short-lived; minutes suffice).
3. SQL SECOND: paste the checksum-matched `018_r1_rollback.sql` (byte-exact
   017 bodies, test-asserted; ends with its own verification DO block that
   RAISEs unless the duration requirement provably returned, SECURITY
   DEFINER and service_role EXECUTE held, and no overload appeared).
4. POST-ROLLBACK VERIFICATION: run the namespace-qualified preflight grid
   (expect the 017 shape); then one live no-token test booking through the
   normal flow — expect success WITH a stored duration again — and cancel it
   by the usual protocol.

The reverse order (SQL before code) is FORBIDDEN by this runbook.

## Display contract (controlling decision applied — no narrowing)

The stored-ETA and duration displays are REMOVED, not NULL-blanked: the
create doorbell's eta line, the completion receipt's duration line, and the
trip page's "~N min ride"/EST. ARRIVAL block are deleted outright, legacy
rows included — the browser also stopped transmitting `durationMinutes` in
every mode. Google attribution on the trip page is DECOUPLED from duration
and stays visible with the route text, which remains Google-derived until
B1-G. (An earlier draft proposed NULL-blanking with legacy rows still
displaying; Codex round 1 correctly ruled the controlling plan and Andres's
prior decision required removal.)

## What this runbook does NOT cover

- Historical rows (bookings.duration_minutes on old rows, historical
  payload_projection contents): R2, separately authorized, restore point
  required.
- The pricing activation ladder: R1 unblocks the token-bearing browser flag
  but does not authorize any rung.
- The B1 milestones: 018 deliberately leaves every venue-directory concern to
  B1-A and later.
