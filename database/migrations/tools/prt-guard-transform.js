#!/usr/bin/env node
// PR-T — pickup-time integrity: the ONE guard transform.
//
// Both PR-T SQL artifacts are DERIVED, never hand-edited:
//   * 019_prt_pickup_time_integrity.sql = the migration-018 writer bodies
//     with the pickup guard applied, plus helper/verification/smoke;
//   * 018_r1_rollback.sql (regenerated)  = the migration-017 writer bodies
//     with the SAME guard applied, plus a self-contained helper so the
//     restored bodies are valid whether or not 019 was ever installed.
//
// tests/prt-pickup-integrity.test.js re-runs this transform and asserts the
// committed files equal its output byte-for-byte, then EXECUTES both on real
// PostgreSQL (PGlite). Anchors are asserted unique inside each extracted
// body — a silent drift in either source migration fails loudly here.
//
// Guard contract (plan v8.6 §3E + Codex seq:201):
//   PRE-MUTATION  — transaction_timestamp(), before rpc_writer 'on', outside
//                   every verified-only branch: elapsed -> RETURN outcome.
//   FINAL         — clock_timestamp(), the LAST potentially blocking
//                   statement of the inner subtransaction: AFTER the
//                   quote_verifications insert, immediately before
//                   set_config('off') + RETURN. Raises SQLSTATE ZQ019.
//   HANDLER       — dedicated ZQ019 branch: resets rpc_writer and returns
//                   pickup_time_elapsed AFTER every write rolled back. Never
//                   ZQ017, never a verdict row, verdict CHECK untouched.
//   HELPER        — public.linkmia_pickup_is_future(TIMESTAMPTZ, TIMESTAMPTZ)
//                   LANGUAGE sql IMMUTABLE STRICT, security invoker, owned by
//                   the captured writer owner; EXECUTE grantees canonicalized
//                   to EXACTLY the captured writer owner(s) — PUBLIC, anon,
//                   authenticated, service_role and any other grantee revoked,
//                   the exact set verified.

'use strict';
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.resolve(__dirname, '..');
const SRC_017 = path.join(MIG_DIR, '017_quote_enforcement_foundation.sql');
const SRC_018 = path.join(MIG_DIR, '018_r1_route_content_non_retention.sql');
const OUT_019 = path.join(MIG_DIR, '019_prt_pickup_time_integrity.sql');
const OUT_RB = path.join(MIG_DIR, '018_r1_rollback.sql');

const HELPER_SIG = 'public.linkmia_pickup_is_future(timestamptz,timestamptz)';
const HELPER_SQL = `-- The comparator, as ONE named IMMUTABLE STRICT SQL function so the exact
-- boundary is observable: a pickup exactly AT the supplied instant is refused,
-- one microsecond later passes. Security INVOKER (no SECURITY DEFINER),
-- schema-qualified at every call site.
CREATE OR REPLACE FUNCTION public.linkmia_pickup_is_future(p_pickup TIMESTAMPTZ, p_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT
AS $prt_helper$ SELECT p_pickup > p_at $prt_helper$;`;

// Ownership + ACL, from the CAPTURED writer owner(s). The EXACT allowed
// EXECUTE set is {helper owner} ∪ {every DISTINCT captured writer owner}.
// CREATE OR REPLACE keeps a pre-existing function's ACL, so the named revokes
// alone would let a grantee added by anything else (or by an earlier install)
// survive a rollback/re-apply: every EXECUTE grantee outside the allowed set
// — PUBLIC included — is revoked here, and the verification block proves the
// set is exact. Fail-closed by construction, not by enumeration.
function helperAclSql(preStateTable, tag) {
  return `DO $${tag}_helper_acl$
DECLARE
  v_owner OID;
  v_owner_name TEXT;
  v_allowed OID[];
  v_grantees OID[];
  v_grantee OID;
  v_row RECORD;
BEGIN
  SELECT proowner INTO v_owner FROM ${preStateTable} WHERE proname = 'accept_quote_create';
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'PR-T: captured writer owner missing';
  END IF;
  SELECT rolname INTO v_owner_name FROM pg_roles WHERE oid = v_owner;
  EXECUTE format('ALTER FUNCTION ${HELPER_SIG} OWNER TO %I', v_owner_name);
  SELECT array_agg(DISTINCT proowner ORDER BY proowner) INTO v_allowed FROM ${preStateTable};
  EXECUTE 'REVOKE EXECUTE ON FUNCTION ${HELPER_SIG} FROM PUBLIC';
  FOR v_row IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION ${HELPER_SIG} FROM %I', v_row.rolname);
  END LOOP;
  FOR v_row IN SELECT DISTINCT r.rolname FROM ${preStateTable} s JOIN pg_roles r ON r.oid = s.proowner
      WHERE s.proowner <> v_owner LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION ${HELPER_SIG} TO %I', v_row.rolname);
  END LOOP;
  -- CANONICALIZE: revoke every EXECUTE grantee outside the allowed set
  -- (grantee 0 is PUBLIC). Materialized first, then revoked.
  SELECT array_agg(DISTINCT (x.a).grantee) INTO v_grantees
    FROM (SELECT aclexplode(p.proacl) AS a FROM pg_proc p
          WHERE p.oid = '${HELPER_SIG}'::regprocedure) x
    WHERE (x.a).privilege_type = 'EXECUTE'
      AND ((x.a).grantee = 0 OR NOT ((x.a).grantee = ANY (v_allowed)));
  FOREACH v_grantee IN ARRAY COALESCE(v_grantees, ARRAY[]::OID[]) LOOP
    IF v_grantee = 0 THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION ${HELPER_SIG} FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE EXECUTE ON FUNCTION ${HELPER_SIG} FROM %I', pg_get_userbyid(v_grantee));
    END IF;
  END LOOP;
END;
$${tag}_helper_acl$;`;
}

function helperVerifySql(preStateTable, tag) {
  return `  -- Helper: exactly one signature, IMMUTABLE, STRICT, security INVOKER,
  -- owned by the captured writer owner, every client role denied — and still
  -- callable by the writers (owner privilege), verified behaviorally.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'linkmia_pickup_is_future') <> 1 THEN
    RAISE EXCEPTION 'PR-T: helper must have exactly one signature';
  END IF;
  SELECT p.* INTO v_helper FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'linkmia_pickup_is_future';
  IF v_helper.provolatile <> 'i' OR NOT v_helper.proisstrict OR v_helper.prosecdef THEN
    RAISE EXCEPTION 'PR-T: helper must be IMMUTABLE STRICT and security invoker';
  END IF;
  IF v_helper.proowner <> (SELECT proowner FROM ${preStateTable} WHERE proname = 'accept_quote_create') THEN
    RAISE EXCEPTION 'PR-T: helper owner must be the captured writer owner';
  END IF;
  IF has_function_privilege('anon', v_helper.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_helper.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_helper.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PR-T: a client or service role can execute the helper';
  END IF;
  -- EXACT ACL: the EXECUTE grantee set equals the captured writer owner set —
  -- nothing more (PUBLIC included), nothing less. A NULL ACL means defaults
  -- (PUBLIC executes) and fails.
  SELECT array_agg(DISTINCT proowner ORDER BY proowner) INTO v_expected_grantees FROM ${preStateTable};
  SELECT array_agg(DISTINCT (x.a).grantee ORDER BY (x.a).grantee) INTO v_actual_grantees
    FROM (SELECT aclexplode(v_helper.proacl) AS a) x
    WHERE (x.a).privilege_type = 'EXECUTE';
  IF v_helper.proacl IS NULL OR v_actual_grantees IS DISTINCT FROM v_expected_grantees THEN
    RAISE EXCEPTION 'PR-T: helper EXECUTE grantees % are not exactly the captured writer owners %',
      v_actual_grantees, v_expected_grantees;
  END IF;
  IF NOT public.linkmia_pickup_is_future(now() + interval '1 microsecond', now())
     OR public.linkmia_pickup_is_future(now(), now()) THEN
    RAISE EXCEPTION 'PR-T: helper boundary is wrong (strictly-later must pass, exact-now must refuse)';
  END IF;
`;
}

// ---- the transform ---------------------------------------------------------
const ANCHOR_ON = "  PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);\n";
const ANCHOR_OFF_RETURN = (outcome) =>
  `    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);\n    RETURN jsonb_build_object('outcome', '${outcome}'`;
const ANCHOR_UNIQUE = "  WHEN unique_violation THEN\n";
const ANCHOR_PICKUP = 'v_pickup_at :=';
const ANCHOR_TELEMETRY = '    INSERT INTO quote_verifications (';

const PRE_GUARD = `  -- PR-T pre-mutation pickup guard: transaction-stable clock, OUTSIDE every
  -- verified-only branch (all three verdicts obey it). An elapsed pickup
  -- returns before any business write; the guard itself records nothing.
  -- Pre-existing and deliberately NOT moved: the edit writer's inherited
  -- 017 telemetry row for an operationId-less caller in off/observe
  -- ('no_request_id', written ABOVE this guard, outside the subtransaction)
  -- is the one row such a legacy caller still leaves — pinned by the
  -- executed suite. The browser always sends an operationId.
  IF NOT public.linkmia_pickup_is_future(v_pickup_at, transaction_timestamp()) THEN
    RETURN jsonb_build_object('outcome', 'pickup_time_elapsed');
  END IF;

`;
const FINAL_GUARD = `    -- PR-T final pickup guard: the LAST potentially blocking statement in
    -- this subtransaction — AFTER the telemetry insert, on the live clock.
    -- A pickup that elapsed during any lock wait rolls every write back.
    IF NOT public.linkmia_pickup_is_future(v_pickup_at, clock_timestamp()) THEN
      RAISE EXCEPTION USING ERRCODE = 'ZQ019', MESSAGE = 'pickup_time_elapsed';
    END IF;
`;
const HANDLER = `  WHEN SQLSTATE 'ZQ019' THEN
    -- PR-T: every booking/acceptance/receipt/telemetry write INSIDE the
    -- subtransaction rolled back with it. No verdict row is written by the
    -- guard (the closed verdict CHECK is untouched) and v_effective_verdict
    -- is never changed. A telemetry row written BEFORE the block (the edit
    -- writer's operationId-less 'no_request_id' instrument) is outside it
    -- and survives, exactly as it did before PR-T.
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    RETURN jsonb_build_object('outcome', 'pickup_time_elapsed');

`;

function once(body, anchor, label) {
  const n = body.split(anchor).length - 1;
  if (n !== 1) throw new Error(`${label}: anchor must appear exactly once, found ${n}`);
  return body.indexOf(anchor);
}

function extract(src, name) {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('$$;', start) + 3;
  return src.slice(start, end);
}

// Applies the guard to ONE extracted writer body. `kind` selects the success
// outcome anchor ('created' | 'updated').
function applyPickupGuard(body, kind) {
  const outcome = kind === 'create' ? 'created' : 'updated';
  if (body.includes('linkmia_pickup_is_future')) throw new Error(`${kind}: body already guarded`);

  const onAt = once(body, ANCHOR_ON, `${kind} rpc_writer on`);
  const pickupAt = once(body, ANCHOR_PICKUP, `${kind} v_pickup_at`);
  if (pickupAt > onAt) throw new Error(`${kind}: v_pickup_at must be resolved before rpc_writer on`);
  let out = body.slice(0, onAt) + PRE_GUARD + body.slice(onAt);

  const offAnchor = ANCHOR_OFF_RETURN(outcome);
  const offAt = once(out, offAnchor, `${kind} set_config off + RETURN ${outcome}`);
  // The final guard must follow the LAST telemetry insert of the success path.
  const lastTelemetry = out.lastIndexOf(ANCHOR_TELEMETRY, offAt);
  if (lastTelemetry < 0 || lastTelemetry > offAt) throw new Error(`${kind}: telemetry insert not found before RETURN`);
  out = out.slice(0, offAt) + FINAL_GUARD + out.slice(offAt);

  const uniqAt = once(out, ANCHOR_UNIQUE, `${kind} unique_violation handler`);
  out = out.slice(0, uniqAt) + HANDLER + out.slice(uniqAt);
  return out;
}

// ---- artifact assembly ------------------------------------------------------
const PRE_CAPTURE = (table, tag, label) => `-- ------------------------------------------------------------
-- PRE-CAPTURE: exact namespace-qualified identities, owners and ACLs of both
-- writers BEFORE replacement (regprocedure resolution is itself fail-closed).
-- ------------------------------------------------------------
CREATE TEMP TABLE ${table} ON COMMIT DROP AS
SELECT p.oid, p.proname, p.proowner, p.proacl, p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.oid IN ('public.accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb)'::regprocedure,
                'public.accept_quote_edit(uuid,uuid,uuid,text,uuid,integer,text,uuid,text,jsonb,numeric,text,text,text,jsonb)'::regprocedure);

DO $${tag}_precheck$
DECLARE v_row RECORD;
BEGIN
  IF (SELECT count(*) FROM ${table}) <> 2 THEN
    RAISE EXCEPTION '${label}: expected exactly the two public writers before replacement';
  END IF;
  FOR v_row IN SELECT * FROM ${table} LOOP
    IF has_function_privilege('anon', v_row.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '${label}: client role holds EXECUTE on % — refuse over privilege drift', v_row.proname;
    END IF;
    IF NOT has_function_privilege('service_role', v_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '${label}: service_role lacks EXECUTE on % — refuse over privilege drift', v_row.proname;
    END IF;
  END LOOP;
END;
$${tag}_precheck$;
`;

const WRITER_VERIFY = (table, tag, label, extraBodyChecks) => `DO $${tag}_verify$
DECLARE
  v_def TEXT;
  v_row RECORD;
  v_helper pg_proc%ROWTYPE;
  v_expected_grantees OID[];
  v_actual_grantees OID[];
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'accept_quote_create') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'accept_quote_edit') <> 1 THEN
    RAISE EXCEPTION '${label}: overload detected — replacement must not add a signature';
  END IF;
${helperVerifySql(table, tag)}
  FOR v_row IN SELECT * FROM ${table} LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = v_row.oid AND n.nspname = 'public'
        AND p.proname = v_row.proname
        AND p.proowner = v_row.proowner
        AND p.proacl IS NOT DISTINCT FROM v_row.proacl
        AND p.proconfig IS NOT DISTINCT FROM v_row.proconfig
    ) THEN
      RAISE EXCEPTION '${label}: identity/owner/ACL/config drifted for % during replacement', v_row.proname;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_row.oid) THEN
      RAISE EXCEPTION '${label}: SECURITY DEFINER was lost on %', v_row.proname;
    END IF;
    IF v_row.proconfig IS NULL OR array_to_string(v_row.proconfig, ',') NOT LIKE '%search_path%' THEN
      RAISE EXCEPTION '${label}: SET search_path drifted on %', v_row.proname;
    END IF;
    IF NOT has_function_privilege('service_role', v_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '${label}: service_role lost EXECUTE on %', v_row.proname;
    END IF;
    IF has_function_privilege('anon', v_row.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '${label}: client role gained EXECUTE on %', v_row.proname;
    END IF;

    v_def := pg_get_functiondef(v_row.oid);
    -- Both guards present on the right clocks, in SEQUENCE: LIKE proves the
    -- pre-mutation guard precedes rpc_writer 'on', and that the final guard
    -- is followed by ERRCODE ZQ019, set_config 'off' and the RETURN. This is
    -- a presence/sequence TRIPWIRE, not the order authority: "some telemetry
    -- INSERT precedes the final guard" is satisfied by any earlier insert.
    -- The EXACT order (final guard after the LAST success-path telemetry
    -- insert) is pinned by the executed suite's STATEMENT ORDER row, which
    -- compares positions in both artifacts.
    IF v_def NOT LIKE '%linkmia_pickup_is_future(v_pickup_at, transaction_timestamp())%rpc_writer'', ''on''%' THEN
      RAISE EXCEPTION '${label}: pre-mutation pickup guard missing or misplaced in %', v_row.proname;
    END IF;
    IF v_def NOT LIKE '%INSERT INTO quote_verifications%linkmia_pickup_is_future(v_pickup_at, clock_timestamp())%ERRCODE = ''ZQ019''%rpc_writer'', ''off''%RETURN jsonb_build_object(''outcome'', ''%' THEN
      RAISE EXCEPTION '${label}: final pickup guard missing or not the last blocking statement in %', v_row.proname;
    END IF;
    IF v_def NOT LIKE '%WHEN SQLSTATE ''ZQ019'' THEN%''pickup_time_elapsed''%' THEN
      RAISE EXCEPTION '${label}: dedicated ZQ019 handler missing in %', v_row.proname;
    END IF;
    IF v_def LIKE '%v_effective_verdict := ''pickup_time_elapsed''%' THEN
      RAISE EXCEPTION '${label}: pickup_time_elapsed must never become a verdict in %', v_row.proname;
    END IF;
${extraBodyChecks}
  END LOOP;
END;
$${tag}_verify$;
`;

// Rollback-contained behavioral smoke (sentinel ZZ019): real writes through
// the replaced functions prove the guard, then everything rolls back and the
// row counts are proven unchanged. Accepts mode 'off' OR 'observe' — this is
// the production state at authoring time (observe).
const SMOKE = `-- ------------------------------------------------------------
-- ROLLBACK-CONTAINED BEHAVIORAL SMOKE (017/018 discipline, sentinel ZZ019):
-- a no-token create with an ELAPSED pickup answers pickup_time_elapsed and
-- writes nothing; a future create succeeds; an edit of that booking with an
-- elapsed proposed pickup answers pickup_time_elapsed; a future edit
-- succeeds. Then forced rollback and a row-count residue proof. Sequence
-- values consumed are deliberately not rewound (018 precedent).
-- ------------------------------------------------------------
DO $prt_smoke$
DECLARE
  v_bookings_before BIGINT;
  v_customers_before BIGINT;
  v_accept_before BIGINT;
  v_verify_before BIGINT;
  v_receipts_before BIGINT;
  v_customer UUID;
  v_auth UUID := gen_random_uuid();
  v_booking UUID;
  v_op1 UUID := gen_random_uuid();
  v_op2 UUID := gen_random_uuid();
  v_op3 UUID := gen_random_uuid();
  v_op4 UUID := gen_random_uuid();
  v_result JSONB;
  v_future TEXT := (clock_timestamp() + interval '1 day')::TEXT;
  v_past TEXT := (clock_timestamp() - interval '1 minute')::TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pricing_state WHERE singleton AND mode IN ('off','observe')) THEN
    RAISE EXCEPTION 'PR-T smoke requires pricing mode off or observe — runbook STOP applies';
  END IF;
  SELECT count(*) INTO v_bookings_before FROM bookings;
  SELECT count(*) INTO v_customers_before FROM customers;
  SELECT count(*) INTO v_accept_before FROM quote_acceptances;
  SELECT count(*) INTO v_verify_before FROM quote_verifications;
  SELECT count(*) INTO v_receipts_before FROM operation_receipts;

  BEGIN
    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-019-PRT-SMOKE','0000000019','prtsmoke@example.invalid','guest','website')
      RETURNING id INTO v_customer;

    -- 1. elapsed pickup -> refused before any write
    v_result := accept_quote_create(
      v_auth, v_customer, v_op1, encode(extensions.digest(v_op1::text, 'sha256'), 'hex'),
      'no_token', NULL, NULL, NULL, 40.00, NULL, NULL, NULL,
      jsonb_build_object('trip_id','MIG019-PAST','customer_name','MIGRATION-019-PRT-SMOKE',
        'customer_phone','0000000019','pickup_location','prt-smoke-origin',
        'dropoff_location','prt-smoke-destination','pickup_datetime',v_past,
        'passengers',1,'bags',0,'vehicle_type','sedan','vehicle_name','Tesla Model Y',
        'booking_mode','dropoff','source','website'));
    IF v_result->>'outcome' IS DISTINCT FROM 'pickup_time_elapsed' THEN
      RAISE EXCEPTION 'PR-T smoke: elapsed create was not refused: %', v_result;
    END IF;
    IF (SELECT count(*) FROM bookings) <> v_bookings_before
       OR (SELECT count(*) FROM operation_receipts) <> v_receipts_before
       OR (SELECT count(*) FROM quote_verifications) <> v_verify_before THEN
      RAISE EXCEPTION 'PR-T smoke: an elapsed create wrote something';
    END IF;

    -- 2. future pickup -> created
    v_result := accept_quote_create(
      v_auth, v_customer, v_op2, encode(extensions.digest(v_op2::text, 'sha256'), 'hex'),
      'no_token', NULL, NULL, NULL, 40.00, NULL, NULL, NULL,
      jsonb_build_object('trip_id','MIG019-FUTURE','customer_name','MIGRATION-019-PRT-SMOKE',
        'customer_phone','0000000019','pickup_location','prt-smoke-origin',
        'dropoff_location','prt-smoke-destination','pickup_datetime',v_future,
        'passengers',1,'bags',0,'vehicle_type','sedan','vehicle_name','Tesla Model Y',
        'booking_mode','dropoff','source','website'));
    IF v_result->>'outcome' IS DISTINCT FROM 'created' THEN
      RAISE EXCEPTION 'PR-T smoke: future create failed: %', v_result;
    END IF;
    v_booking := (v_result->>'booking_id')::UUID;

    -- 3. edit proposing an elapsed pickup -> refused, row untouched
    v_result := accept_quote_edit(
      v_auth, v_customer, v_op3, encode(extensions.digest(v_op3::text, 'sha256'), 'hex'),
      v_booking, 1, 'no_token', NULL, NULL, NULL, 41.00, NULL, NULL, NULL,
      jsonb_build_object('pickup_datetime', v_past));
    IF v_result->>'outcome' IS DISTINCT FROM 'pickup_time_elapsed' THEN
      RAISE EXCEPTION 'PR-T smoke: elapsed edit was not refused: %', v_result;
    END IF;
    IF (SELECT details_version FROM bookings WHERE id = v_booking) <> 1 THEN
      RAISE EXCEPTION 'PR-T smoke: an elapsed edit changed the row';
    END IF;

    -- 4. edit proposing a future pickup -> updated
    v_result := accept_quote_edit(
      v_auth, v_customer, v_op4, encode(extensions.digest(v_op4::text, 'sha256'), 'hex'),
      v_booking, 1, 'no_token', NULL, NULL, NULL, 41.00, NULL, NULL, NULL,
      jsonb_build_object('pickup_datetime', (clock_timestamp() + interval '2 days')::TEXT));
    IF v_result->>'outcome' IS DISTINCT FROM 'updated' THEN
      RAISE EXCEPTION 'PR-T smoke: future edit failed: %', v_result;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'ZZ019', MESSAGE = 'MIGRATION_019_PRT_SMOKE_ROLLBACK';
  EXCEPTION WHEN SQLSTATE 'ZZ019' THEN
    IF SQLERRM <> 'MIGRATION_019_PRT_SMOKE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF (SELECT count(*) FROM bookings) <> v_bookings_before
     OR (SELECT count(*) FROM customers) <> v_customers_before
     OR (SELECT count(*) FROM quote_acceptances) <> v_accept_before
     OR (SELECT count(*) FROM quote_verifications) <> v_verify_before
     OR (SELECT count(*) FROM operation_receipts) <> v_receipts_before THEN
    RAISE EXCEPTION 'PR-T smoke residue: rollback-contained smoke changed row counts';
  END IF;
END;
$prt_smoke$;
`;

function build019(m018) {
  const create = applyPickupGuard(extract(m018, 'accept_quote_create'), 'create');
  const edit = applyPickupGuard(extract(m018, 'accept_quote_edit'), 'edit');
  return `-- ============================================================
-- Migration 019 — PR-T: pickup-time integrity (plan v8.6 §3E)
--
-- GENERATED by database/migrations/tools/prt-guard-transform.js from the
-- migration-018 writer bodies. Do not hand-edit: regenerate, and the
-- executed suite (tests/prt-pickup-integrity.test.js) asserts byte-equality.
--
-- WHAT THIS DOES
--   * adds public.linkmia_pickup_is_future(TIMESTAMPTZ, TIMESTAMPTZ) — the
--     comparator, IMMUTABLE STRICT, security invoker, client roles denied;
--   * accept_quote_create / accept_quote_edit: every genuinely NEW write
--     requires the submitted/proposed pickup to be strictly future —
--     checked before mutation on the transaction-stable clock, and again as
--     the LAST blocking statement of the inner subtransaction on the live
--     clock (SQLSTATE ZQ019 -> every write rolls back -> outcome
--     pickup_time_elapsed). Receipt-first replay ordering is preserved: an
--     exact retry lands on its receipt before any clock is consulted.
--
-- WHAT THIS DOES NOT DO
--   * no table, column, index, constraint, trigger or RLS change; NO grant
--     change to the EXISTING writers (identity/owner/ACL/config are verified
--     equal to the pre-capture). The NEW helper is the one ACL event: it
--     receives a RESTRICTED ACL — EXECUTE for the captured writer owner(s)
--     only; PUBLIC, anon, authenticated, service_role and every other grantee
--     revoked, and the exact grantee set verified;
--   * the quote_verifications verdict CHECK is untouched — the GUARD records
--     NO verdict row (no verdict named pickup_time_elapsed exists). The edit
--     writer's pre-existing operationId-less 'no_request_id' instrument
--     (off/observe, written before the guard) is unchanged and pinned, not
--     moved; ZQ017 is not reused;
--   * signatures are IDENTICAL (true in-place replacement);
--   * no minimum lead time; fares, tokens, cancellation and driver-status
--     semantics are unchanged; accept_optional_edit is untouched.
--
-- RUN VIA docs/PRT-MIGRATION-RUNBOOK.md ONLY. Emergency rollback:
-- database/migrations/018_r1_rollback.sql (017 bodies WITH this guard;
-- self-contained — creates the helper first).
-- ============================================================

BEGIN;

${PRE_CAPTURE('prt_pre_state', 'prt', 'PR-T')}
${HELPER_SQL}

${helperAclSql('prt_pre_state', 'prt')}

${create}

${edit}

-- ------------------------------------------------------------
-- Self-verification (017/018 discipline): raise = whole transaction aborts.
-- ------------------------------------------------------------
${WRITER_VERIFY('prt_pre_state', 'prt', 'PR-T', `    -- 018 semantics must still hold: no persisted duration.
    IF v_row.proname = 'accept_quote_create' AND v_def NOT LIKE '%NULL::INTEGER%' THEN
      RAISE EXCEPTION 'PR-T: the create insert persists a duration again';
    END IF;
    IF v_row.proname = 'accept_quote_edit' AND v_def NOT LIKE '%duration_minutes = NULL%' THEN
      RAISE EXCEPTION 'PR-T: the edit update persists a duration again';
    END IF;`)}
${SMOKE}
COMMIT;
`;
}

function buildRollback(m017) {
  const create = applyPickupGuard(extract(m017, 'accept_quote_create'), 'create');
  const edit = applyPickupGuard(extract(m017, 'accept_quote_edit'), 'edit');
  return `-- ============================================================
-- Migration 018 EMERGENCY ROLLBACK — restores the migration-017 bodies of
-- accept_quote_create and accept_quote_edit WITH the PR-T pickup guard.
--
-- GENERATED by database/migrations/tools/prt-guard-transform.js: the 017
-- bodies (extracted programmatically) with the SAME guard transform that
-- produced 019. tests/r1-route-content.test.js and
-- tests/prt-pickup-integrity.test.js assert the match byte-for-byte.
--
-- PHASE-SAFE (Codex seq:201): PR-T code deploys BEFORE its migration, so this
-- artifact must be valid on BOTH sides of 019's installation. It therefore
-- creates/replaces the helper FIRST — assigned from the captured writer
-- ownership, client roles denied — and only then restores the guard-carrying
-- writers. Restoring writers that reference an absent helper would succeed
-- at CREATE (PL/pgSQL resolves at run time) and then fail on first
-- execution: an outage installed by the rollback itself. Never do that.
--
-- Signatures identical, so ACLs/ownership/SECURITY DEFINER survive.
-- Run only under docs/R1-MIGRATION-RUNBOOK.md's rollback procedure.
-- NOTE: restoring 017 restores the verified-duration REQUIREMENT — after
-- rollback, verified consumptions again refuse a NULL duration. That is the
-- known, reviewed price of rollback.
-- ============================================================

BEGIN;

${PRE_CAPTURE('r1_rb_pre_state', 'r1_rb', 'R1 rollback')}
${HELPER_SQL}

${helperAclSql('r1_rb_pre_state', 'r1_rb')}

${create}

${edit}

-- Post-restore verification: 017 semantics PROVABLY back, the guard and its
-- helper PROVABLY present, identity/owner/ACL/config equal to the pre-capture,
-- privilege ceiling re-proven behaviorally.
${WRITER_VERIFY('r1_rb_pre_state', 'r1_rb', 'R1 rollback', `    IF v_def NOT LIKE '%v_duration_minutes IS NULL%' THEN
      RAISE EXCEPTION 'R1 rollback: the 017 verified-duration requirement did not return on %', v_row.proname;
    END IF;`)}
COMMIT;
`;
}

function generate() {
  const m017 = fs.readFileSync(SRC_017, 'utf8');
  const m018 = fs.readFileSync(SRC_018, 'utf8');
  return { migration: build019(m018), rollback: buildRollback(m017) };
}

if (require.main === module) {
  const { migration, rollback } = generate();
  const mode = process.argv[2];
  if (mode === '--write') {
    fs.writeFileSync(OUT_019, migration);
    fs.writeFileSync(OUT_RB, rollback);
    console.log(`wrote ${path.basename(OUT_019)} (${migration.length} bytes) and ${path.basename(OUT_RB)} (${rollback.length} bytes)`);
  } else if (mode === '--check') {
    const a = fs.readFileSync(OUT_019, 'utf8') === migration;
    const b = fs.readFileSync(OUT_RB, 'utf8') === rollback;
    console.log(`019 ${a ? 'matches' : 'DIFFERS'}; rollback ${b ? 'matches' : 'DIFFERS'}`);
    process.exit(a && b ? 0 : 1);
  } else {
    console.log('usage: prt-guard-transform.js --write | --check');
    process.exit(2);
  }
}

module.exports = { applyPickupGuard, extract, generate, build019, buildRollback, HELPER_SQL, HELPER_SIG,
  PRE_GUARD, FINAL_GUARD, HANDLER, OUT_019, OUT_RB, SRC_017, SRC_018 };
