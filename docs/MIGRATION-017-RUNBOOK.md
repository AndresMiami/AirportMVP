# Migration 017 rollout and emergency runbook

This document is procedure, not authorization. Migration 017 remains unrun
until Andres explicitly approves the checksum-matched, manifest-filled SQL
artifact produced from the reviewed correction commit.

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
   today's host status.
4. Create a rollout copy of migration 017 and replace only its commented
   manifest example with that decision set. Preserve the exact file securely,
   record its SHA-256, review its diff against the correction commit, and rerun
   the executed PostgreSQL smoke plus rollback/reapply harness against those
   exact manifest-filled bytes on a replica seeded with the reviewed candidate
   IDs. The reviewed rollout artifact—not the unfilled git template—is the SQL
   later authorized for production.
5. Resolve every NULL/unsafe fare and every non-exempt customer with multiple
   active bookings. Re-run the preflight until all hard gates pass.
6. Take a Supabase restore/PITR marker and record the current catalog, booking
   row count, trigger states and service-role privilege evidence.

## Quiet-window installation

1. Pause LinkMia booking writers and the watchdog under a separate explicit
   production authorization. Keep the quote service and browser quote flag
   disabled.
2. Re-run the activity snapshot from preflight check C1. It is evidence, not
   a lock: migration 017 takes `NOWAIT` locks and aborts cleanly if another
   transaction holds a conflicting lock at that instant.
3. Recompute the rollout file's SHA-256 and match it to the reviewed record.
   Paste those exact manifest-filled bytes into Supabase SQL Editor and run
   them once. Only `Success. No rows returned` is a pass. Any error means the
   transaction rolled back; diagnose and restart from preflight rather than
   executing fragments or editing the artifact in place.
4. Independently verify tables/RLS/policies, columns/constraints, all five
   enabled foundation triggers, function SECURITY DEFINER/search paths, RPC
   EXECUTE grants, service-role table/sequence ceilings and `pricing_state=off`.
5. While writers are still paused, smoke as `service_role`: legacy booking
   INSERT, pending-to-confirmed assignment, cancellation, telemetry INSERT and
   each new RPC. Verify no test residue.
6. Resume the existing writers. Confirm ordinary booking, Accept, cancellation,
   release and watchdog paths remain healthy before ending the window.

Installing 017 does not enable server pricing. The state begins at `off`, the
quote endpoint remains kill-switched and the browser flag remains false.

## Emergency rollback

Use the rollback block embedded at the end of migration 017 only when all
pricing/booking writers are paused and forward repair is unsafe.

The rollback is destructive to 017's evidence: it drops quote acceptances,
verification telemetry, operation receipts, frozen actor classification and
the enforcement high-water mark. After reinstalling, a previously consumed
quote or operation may be accepted again. Take a fresh PITR marker first.

1. Pause all writers and confirm the quiet window.
2. Copy the entire rollback block, uncomment it, review it against the exact
   installed migration version and run it as one transaction.
3. Its catalog self-check must pass before `NOTIFY pgrst` and `COMMIT`.
4. Verify the pre-017 catalog/ACL/trigger state, existing application paths and
   absence of partial 017 artifacts.
5. Keep server pricing disabled. Reinstallation requires the full preflight,
   reviewed manifest and a new explicit authorization.
