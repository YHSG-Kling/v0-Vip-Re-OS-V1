-- Wave 91 (lane 91D) demo cleanup. Replace __B__ with the demo brokerage id.
-- Counts every deleted row (GET DIAGNOSTICS ROW_COUNT) per table; repeats passes
-- until a pass deletes nothing (FK order resolves itself), then removes the
-- tagged non-tenant rows (prospect, audit, auth users) and the brokerage.
DO $w91c$ DECLARE tn text; n int; total int := 0; pass int; changed boolean; B uuid := '__B__'::uuid; cnt jsonb := '{}'::jsonb; errs jsonb := '{}'::jsonb;
BEGIN
  FOR pass IN 1..15 LOOP
    changed := false;
    FOR tn IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE' WHERE c.table_schema = 'public' AND c.column_name = 'brokerage_id' AND c.table_name NOT IN ('brokerages') LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE brokerage_id = $1', tn) USING B;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN changed := true; total := total + n; cnt := jsonb_set(cnt, ARRAY[tn], to_jsonb(coalesce((cnt->>tn)::int, 0) + n)); END IF;
      EXCEPTION WHEN others THEN errs := jsonb_set(errs, ARRAY[tn], to_jsonb(SQLERRM));
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;
  DELETE FROM public.superadmin_audit_log WHERE details->>'brokerage_id' = B::text OR actor_email ILIKE '%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{superadmin_audit_log}', to_jsonb(n)); END IF;
  DELETE FROM public.platform_prospects WHERE email ILIKE 'w91d.%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{platform_prospects}', to_jsonb(n)); END IF;
  DELETE FROM public.users WHERE email ILIKE 'w91d.%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{users_by_email}', to_jsonb(n)); END IF;
  DELETE FROM public.brokerages WHERE id = B; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{brokerages}', to_jsonb(n)); END IF;
  DELETE FROM auth.users WHERE email ILIKE 'w91d.%@wave91.test'; GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN total := total + n; cnt := jsonb_set(cnt, '{auth_users}', to_jsonb(n)); END IF;
  PERFORM set_config('w91.clean', jsonb_build_object('total', total, 'by_table', cnt, 'errors', errs)::text, true);
EXCEPTION WHEN others THEN PERFORM set_config('w91.clean', jsonb_build_object('fatal', SQLERRM, 'total_before_fatal', total, 'by_table', cnt, 'errors', errs)::text, true);
END $w91c$;
SELECT current_setting('w91.clean', true)::jsonb AS r;
