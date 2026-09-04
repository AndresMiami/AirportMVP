# Migration 017 rollout and emergency runbook

STATUS: migration 017 was INSTALLED in production on 2026-08-23
(checksum-matched, manifest-filled artifact; preflight all-pass;
post-install grid + rollback-contained smoke verified; watchdog resumed).
The install sections below are the HISTORICAL procedure of that completed
window; the EMERGENCY ROLLBACK section remains operationally live.

This document is procedure, not authorization. At authoring time migration
017 remained unrun until Andres explicitly approved the artifact produced
from the reviewed correction commit — that approval was given and executed
as recorded above.

## Before the maintenance window

1. Confirm the exact correction commit and independently reproduce the
   repository suites plus the executed PostgreSQL smoke and rollback/reapply
   harness against its unfilled migration template.
2. Run each labeled check A1–G6 in
   `database/migrations/017_quote_enforcement_preflight.sql` separately in the
   Supabase SQL editor. Each check is a complete read-only transaction with
   exactly one result grid; preserve all 16 grids.
3. Review every historical host-linked customer from F1. Use F2 to build the
   exact reviewed UUID and TRUE/FALSE decision set. Do not infer history from
   today's host status. If F2 returns zero rows, record an empty candidate set
   and leave the manifest insert commented; do not invent a row.
4. Create a rollout copy of migration 017 and replace only its commented
   manifest example with that decision set. F2 already omits the comma from its
   final generated row; keep the terminating semicolon after the last row and
   do not paste a trailing comma. Preserve the exact file securely and run
   `shasum -a 256 <rollout-file.sql>`. Record that hash, the correction commit,
   and the reviewed candidate/decision set in the rollout record. Andres's
   authorization must quote the same hash. Do not format or edit the file after
   hashing. Review its diff against the correction commit, then rerun the
   PostgreSQL smoke plus rollback/reapply harness against those exact
   manifest-filled bytes on a replica seeded with the reviewed candidate IDs.
   On Andres's review workstation the harness is `pglite-harness/`; point its
   `WT` setting at the rollout checkout containing those exact bytes. The
   reviewed rollout artifact—not the unfilled git template—is the SQL later
   authorized for production.
5. Resolve every NULL/unsafe fare and every non-exempt customer with multiple
   active bookings. Re-run the preflight until all hard gates pass.
6. Take a Supabase restore/PITR marker and record the current catalog, booking
   row count, trigger states and service-role privilege evidence.

## Quiet-window installation

1. Under a separate explicit production authorization, set
   `WATCHDOG_DISABLED=1` and redeploy, then confirm the disabled tick. LinkMia
   has no general booking-writer kill switch: use a declared maintenance/quiet
   window, close known passenger/driver tabs, and do not proceed while a known
   booking mutation or writer transaction is in flight. Existing future
   nonterminal bookings are expected and are handled by the reviewed preflight;
   do not cancel or terminalize them merely to run this migration. Keep the
   quote service and browser quote flag disabled.
2. Re-run the activity snapshot from preflight check C1. It is evidence, not
   a lock: migration 017 takes `NOWAIT` locks and aborts cleanly if another
   transaction holds a conflicting lock at that instant. A `NOWAIT` lock error
   is a safe full-transaction abort: return to preflight and retry the identical
   checksum-matched artifact only after the writer is gone.
3. Recompute the rollout file's SHA-256 and match it to the reviewed record.
   Paste those exact manifest-filled bytes into Supabase SQL Editor and run
   them once. Only `Success. No rows returned` is a pass. Any error means the
   transaction rolled back; diagnose and restart from preflight rather than
   executing fragments or editing the artifact in place.
4. Independently verify tables/RLS/policies, columns/constraints, all five
   enabled foundation triggers, function SECURITY DEFINER/search paths, RPC
   EXECUTE grants, service-role table/sequence ceilings and `pricing_state=off`.
   Start with the single grid below, then preserve the migration's detailed
   catalog/ACL self-check evidence beside the preflight and rollout hash.

```sql
SELECT
  (SELECT mode FROM pricing_state WHERE singleton) AS pricing_mode,
  (SELECT count(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
      AND t.tgname IN (
        'bookings_guard_trg','pricing_state_guard_trg',
        'pricing_state_truncate_guard_trg','pricing_state_audit_guard_trg',
        'pricing_state_audit_truncate_guard_trg'
      )) AS enabled_foundation_triggers,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings'
      AND column_name IN (
        'price_cents','price_authority','canonical_place_id','airport_code',
        'route_authority','multi_booking_exempt','active_slot','assignment_epoch'
      )) AS foundation_booking_columns,
  (SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'set_pricing_mode','accept_quote_create',
        'accept_quote_edit','accept_optional_edit'
      )
      AND p.prosecdef
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
    AS correctly_scoped_rpcs;
-- PASS: off | 5 | 8 | 4
```
5. While writers are still paused, run the rollback-contained smoke below as
   the database owner. It switches to `service_role` for every application
   write and RPC. The `ROLLBACK` immediately before the final read-only residue
   grid MUST remain; a post-install production smoke must never commit synthetic
   bookings, notification outbox events, quote evidence, receipts, audit rows,
   or sequence advances.

```sql
BEGIN;
SET LOCAL search_path = public, extensions, pg_temp;

DO $migration_017_postinstall_smoke$
DECLARE
  v_auth UUID := gen_random_uuid();
  v_customer UUID;
  v_driver UUID;
  v_legacy_booking UUID;
  v_rpc_booking UUID;
  v_jti_create UUID := gen_random_uuid();
  v_jti_edit UUID := gen_random_uuid();
  v_pickup TIMESTAMPTZ := date_trunc('second', clock_timestamp() + interval '2 days');
  v_now_ms BIGINT := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
  v_trip TEXT := 'MIG017POST-' || left(replace(gen_random_uuid()::TEXT, '-', ''), 12);
  v_result JSONB;
  v_booking JSONB;
  v_payload JSONB;
  v_audit_seq_last BIGINT;
  v_audit_seq_called BOOLEAN;
  v_verify_seq_last BIGINT;
  v_verify_seq_called BOOLEAN;
BEGIN
  SELECT last_value, is_called INTO v_audit_seq_last, v_audit_seq_called
    FROM pricing_state_audit_id_seq;
  SELECT last_value, is_called INTO v_verify_seq_last, v_verify_seq_called
    FROM quote_verifications_id_seq;

  BEGIN
    INSERT INTO customers (name, phone, email, type, source)
      VALUES (
        'MIGRATION-017-POSTINSTALL', '0000000017',
        'migration-017-postinstall@example.invalid', 'guest', 'website'
      ) RETURNING id INTO v_customer;
    INSERT INTO drivers (name, phone)
      VALUES ('MIGRATION-017-POSTINSTALL', '0000000017')
      RETURNING id INTO v_driver;

    v_booking := jsonb_build_object(
      'trip_id',v_trip || '-RPC',
      'customer_name','MIGRATION-017-POSTINSTALL',
      'customer_phone','0000000017',
      'pickup_location','postinstall-origin',
      'dropoff_location','postinstall-destination',
      'pickup_datetime',v_pickup::TEXT,
      'passengers',1,'bags',0,
      'vehicle_type','sedan','vehicle_name','Sedan',
      'booking_mode','dropoff','source','website','duration_minutes',40
    );

    BEGIN
      EXECUTE 'SET LOCAL ROLE service_role';

    PERFORM set_pricing_mode('off', 'migration-017-postinstall-smoke');
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('no_token', 'off', 'create', repeat('7', 64));

    INSERT INTO bookings (
      trip_id, customer_id, customer_name, customer_phone,
      pickup_location, dropoff_location, pickup_datetime,
      vehicle_type, price, status, source
    ) VALUES (
      v_trip || '-LEGACY', v_customer,
      'MIGRATION-017-POSTINSTALL', '0000000017',
      'postinstall-origin', 'postinstall-destination', v_pickup,
      'sedan', 10.00, 'pending', 'website'
    ) RETURNING id INTO v_legacy_booking;
    UPDATE bookings
      SET status = 'confirmed', assigned_driver = v_driver
      WHERE id = v_legacy_booking;
    UPDATE bookings
      SET status = 'cancelled', cancelled_at = clock_timestamp()
      WHERE id = v_legacy_booking;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-postinstall','jti',v_jti_create::TEXT,
      'purpose','create','authUserId',v_auth::TEXT,
      'customerId',v_customer::TEXT,'vehicle','tesla',
      'pickupAtMs',floor(extract(epoch FROM v_pickup) * 1000)::BIGINT,
      'commitment',repeat('1',64),'routeQuality','traffic_aware',
      'finalCents',1234,'pricingVersion','postinstall',
      'engineVersion','postinstall','resolvedVersion','postinstall',
      'iat',v_now_ms,'exp',v_now_ms + 900000
    );
    v_result := accept_quote_create(
      v_auth, v_customer, gen_random_uuid(), repeat('1', 64),
      'verified', v_jti_create, repeat('4', 64), v_payload, 12.34,
      'postinstall-place', 'MIA', 'tesla', v_booking
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'created' THEN
      RAISE EXCEPTION 'post-install create RPC failed: %', v_result;
    END IF;
    v_rpc_booking := (v_result->>'booking_id')::UUID;

    v_result := accept_optional_edit(
      v_auth, v_customer, gen_random_uuid(), repeat('2', 64),
      v_rpc_booking, 1, jsonb_build_object('notes','postinstall-smoke')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated'
       OR (v_result->>'details_version')::INTEGER IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'post-install optional-edit RPC failed: %', v_result;
    END IF;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-postinstall','jti',v_jti_edit::TEXT,
      'purpose','edit','authUserId',v_auth::TEXT,
      'customerId',v_customer::TEXT,'bookingId',v_rpc_booking::TEXT,
      'assignmentEpoch',0,'vehicle','tesla',
      'pickupAtMs',floor(extract(epoch FROM v_pickup) * 1000)::BIGINT,
      'commitment',repeat('3',64),'routeQuality','traffic_aware',
      'finalCents',1345,'pricingVersion','postinstall',
      'engineVersion','postinstall','resolvedVersion','postinstall',
      'iat',v_now_ms,'exp',v_now_ms + 900000
    );
    v_result := accept_quote_edit(
      v_auth, v_customer, gen_random_uuid(), repeat('3', 64),
      v_rpc_booking, 2, 'verified', v_jti_edit, repeat('5', 64),
      v_payload, 13.45, 'postinstall-place', 'MIA', 'tesla',
      jsonb_build_object(
        'pickup_datetime',v_pickup::TEXT,
        'duration_minutes',41,
        'notes','postinstall-smoke'
      )
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated'
       OR (v_result->>'details_version')::INTEGER IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'post-install quoted-edit RPC failed: %', v_result;
    END IF;

      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
      RAISE;
    END;

    IF NOT EXISTS (
      SELECT 1 FROM bookings
      WHERE id = v_legacy_booking AND status = 'cancelled'
        AND price_authority = 'client_legacy'
    ) OR NOT EXISTS (
      SELECT 1 FROM bookings
      WHERE id = v_rpc_booking AND details_version = 3
        AND price = 13.45 AND price_authority = 'client_legacy'
        AND notes = 'postinstall-smoke'
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_verifications
      WHERE identity_hash = repeat('7', 64) AND verdict = 'no_token'
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances
      WHERE booking_id = v_rpc_booking AND purpose = 'create'
        AND jti = v_jti_create AND token_digest = repeat('4', 64)
        AND authority = 'client_legacy'
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances
      WHERE booking_id = v_rpc_booking AND purpose = 'edit'
        AND jti = v_jti_edit AND token_digest = repeat('5', 64)
        AND authority = 'client_legacy'
    ) OR (
      SELECT count(*) FROM notification_events
      WHERE booking_id = v_legacy_booking AND state = 'pending'
        AND event_type IN ('ride_cancelled_admin','ride_cancelled')
    ) IS DISTINCT FROM 2::BIGINT
    THEN
      RAISE EXCEPTION 'post-install smoke assertions failed';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM setval('public.pricing_state_audit_id_seq',
      v_audit_seq_last, v_audit_seq_called);
    PERFORM setval('public.quote_verifications_id_seq',
      v_verify_seq_last, v_verify_seq_called);
    RAISE;
  END;

  -- nextval()/setval() are not transactional in PostgreSQL. Restore both
  -- identity sequences explicitly; the outer ROLLBACK handles all row state.
  PERFORM setval('public.pricing_state_audit_id_seq',
    v_audit_seq_last, v_audit_seq_called);
  PERFORM setval('public.quote_verifications_id_seq',
    v_verify_seq_last, v_verify_seq_called);
END $migration_017_postinstall_smoke$;

ROLLBACK;

SELECT
  (SELECT count(*) FROM bookings
    WHERE trip_id LIKE 'MIG017POST-%') AS booking_residue,
  (SELECT count(*) FROM customers
    WHERE name = 'MIGRATION-017-POSTINSTALL') AS customer_residue,
  (SELECT count(*) FROM drivers
    WHERE name = 'MIGRATION-017-POSTINSTALL') AS driver_residue,
  (SELECT count(*) FROM notification_events ne
    JOIN bookings b ON b.id = ne.booking_id
    WHERE b.trip_id LIKE 'MIG017POST-%') AS notification_residue;
-- PASS: all four values are 0.
```

   A successful run reports no exception, executes `ROLLBACK`, then shows a
   four-zero residue grid. Confirm the two `MIG017POST-` bookings and their
   cancellation events are absent before resuming the watchdog. Never replace
   the rollback with a commit. If any
   statement errors, the SQL editor may stop before sending the trailing
   `ROLLBACK`; immediately issue `ROLLBACK` in that same session before
   diagnosing or retrying.
6. Resume the existing writers. Confirm ordinary booking, Accept, cancellation,
   and release paths remain healthy. Remove `WATCHDOG_DISABLED`, redeploy, and
   verify the first watchdog tick before ending the window.

Installing 017 does not enable server pricing. The state begins at `off`, the
quote endpoint kill-switched and the browser flag false. (HISTORICAL — that
was the state at install time, 2026-08-23. Since 2026-09-03 the endpoint is
enabled and `pricing_state` is `observe`; the browser-flag activation
release is prepared under review — its passenger-visible effect is
CONDITIONAL on that release deploying — per docs/BROWSER-FLAG-ACTIVATION.md.)

## Emergency rollback

Use the rollback block embedded at the end of migration 017 only when all
pricing/booking writers are paused and forward repair is unsafe.

Rollback triggers include an installed schema that blocks ordinary booking or
lifecycle writers, an unrecoverable privilege/trigger mismatch, or a failed
post-install smoke whose cause cannot be forward-repaired safely inside the
window. A benign `NOWAIT` abort before installation is not a rollback trigger;
the migration transaction already removed every partial change.

The rollback is destructive to 017's evidence: it drops quote acceptances,
verification telemetry, operation receipts, frozen actor classification and
the enforcement high-water mark. After reinstalling, a previously consumed
quote or operation may be accepted again. Take a fresh PITR marker first.

1. Pause all writers and confirm the quiet window.
2. Copy the entire rollback block, uncomment it, review it against the exact
   installed migration version and run it as one transaction.
3. Its catalog self-check must pass before `NOTIFY pgrst` and `COMMIT`.
4. Verify the pre-017 catalog/ACL/trigger state, existing application paths and
   absence of partial 017 artifacts. Compare ACLs to the preserved preflight;
   an already-existing explicit `service_role` grant on `bookings` is not 017
   residue.
5. Keep server pricing disabled. Reinstallation requires the full preflight,
   reviewed manifest and a new explicit authorization.

If owner-level DDL ever removes the guarded `pricing_state` singleton, all
booking writers intentionally fail with `pricing_state singleton missing`.
Do not improvise an INSERT: that could erase the enforcement high-water mark.
Pause writers and recover from the PITR marker, or complete the reviewed
emergency rollback and full authorized reinstall.
