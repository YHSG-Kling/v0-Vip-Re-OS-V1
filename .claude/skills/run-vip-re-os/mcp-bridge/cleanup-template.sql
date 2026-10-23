-- Wave 91 (lane 91D) demo cleanup, reshaped to the lane-93D2 recipe in ../SKILL.md ("Cleanup that
-- stays under 60 s"). Replace __B__ with the demo brokerage id.
--
-- WHY IT IS NOT A WHOLE-SCHEMA DELETE ANY MORE: the original ran a DELETE against EVERY brokerage_id
-- base table, up to 15 passes. SKILL.md records that a whole-schema DO-block delete "timed out at 60 s
-- and rolled back" (664 tables), while the same-size EXISTS census ran in ~0.3 s (SKILL.md's
-- measurement of that pass, not of this block). Only the tables the census finds rows in are deleted from.
--
--   1. CENSUS   EXISTS over every brokerage_id BASE TABLE -> `hits`, the tables holding any row for B.
--   2. DELETE   only `hits`, counting every deleted row (GET DIAGNOSTICS ROW_COUNT) per table. The
--               pass repeats until one deletes nothing: a child blocked by an FK is refused in its own
--               subtransaction and succeeds on a later pass once its children are gone (children
--               first, without hand-ordering), and a table emptied by a CASCADE simply counts 0.
--   3. NON-TENANT  the tagged rows with no brokerage_id: prospect, audit, public.users, auth.users.
--   4. BROKERAGE   the brokerage row itself.
--
-- Do NOT delete from or tally `contact_lead_history` (a VIEW over contacts LEFT JOIN leads — the
-- BASE TABLE filter already excludes it). `offers` cascades from transactions/contacts/listings, so
-- the cascade is counted in by_table. Prove 0 residual afterwards with the same census (it must
-- return hits = 0) plus every tag predicate, and run a positive control: the same census against
-- the SEED brokerage must find rows, or "0" only means the finder is blind.
--
-- `errors` holds census failures (key prefixed `census:`) and refusals from the delete passes; a
-- non-empty `errors` after the final pass is an UNRESOLVED table, not a clean bill.
DO $w91c$ DECLARE tn text; n int; total int := 0; pass int; changed boolean; hit boolean; hits text[] := '{}'; B uuid := '__B__'::uuid; cnt jsonb := '{}'::jsonb; errs jsonb := '{}'::jsonb;
BEGIN
  -- 1. CENSUS (read-only).
  FOR tn IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE' WHERE c.table_schema = 'public' AND c.column_name = 'brokerage_id' AND c.table_name NOT IN ('brokerages') ORDER BY c.table_name LOOP
    BEGIN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE brokerage_id = $1)', tn) INTO hit USING B;
      IF hit THEN hits := hits || tn; END IF;
    EXCEPTION WHEN others THEN errs := jsonb_set(errs, ARRAY['census:' || tn], to_jsonb(SQLERRM));
    END;
  END LOOP;
  -- 2. DELETE only the tables the census found rows in.
  FOR pass IN 1..15 LOOP
    changed := false;
    FOREACH tn IN ARRAY hits LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE brokerage_id = $1', tn) USING B;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN changed := true; total := total + n; cnt := jsonb_set(cnt, ARRAY[tn], to_jsonb(coalesce((cnt->>tn)::int, 0) + n)); END IF;
      EXCEPTION WHEN others THEN errs := jsonb_set(errs, ARRAY[tn], to_jsonb(SQLERRM));
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;
  -- 3. NON-TENANT rows (tagged), 4. the brokerage.
  DELETE FROM public.superadmin_audit_log WHERE details->>'brokerage_id' = B::text OR actor_email ILIKE '%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{superadmin_audit_log}', to_jsonb(n)); END IF;
  DELETE FROM public.platform_prospects WHERE email ILIKE 'w91d.%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{platform_prospects}', to_jsonb(n)); END IF;
  DELETE FROM public.users WHERE email ILIKE 'w91d.%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{users_by_email}', to_jsonb(n)); END IF;
  DELETE FROM public.brokerages WHERE id = B; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{brokerages}', to_jsonb(n)); END IF;
  DELETE FROM auth.users WHERE email ILIKE 'w91d.%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{auth_users}', to_jsonb(n)); END IF;
  PERFORM set_config('w91.clean', jsonb_build_object('total', total, 'census_hits', cardinality(hits), 'by_table', cnt, 'errors', errs)::text, true);
EXCEPTION WHEN others THEN PERFORM set_config('w91.clean', jsonb_build_object('fatal', SQLERRM, 'total_before_fatal', total, 'census_hits', cardinality(hits), 'by_table', cnt, 'errors', errs)::text, true);
END $w91c$;
SELECT current_setting('w91.clean', true)::jsonb AS r;
