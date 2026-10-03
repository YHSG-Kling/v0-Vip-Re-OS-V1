-- m414 — asserts m413.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m413 would undo the narrowings it was checking. Same split as
-- m393/m395/m397/m399/m403/m405/m407/m409/m412.
--
-- WHAT IT ASSERTS
--
-- The eight tables m413 named are no longer readable by PUBLIC. Stated as a
-- membership test against the same list, because the list IS the claim: these
-- are the tables that had no reader, and a later commit that re-opens one of
-- them has re-opened something nothing needs.
--
-- WHAT IT DELIBERATELY DOES NOT ASSERT
--
-- The other 17 `FOR SELECT USING (true)` policies still granted to PUBLIC.
-- Asserting them now would be a red gate on work nobody has been asked to
-- finish, and — worse — it would pressure whoever hits it into narrowing a
-- table that feeds a logged-out page. `subscription_tiers`, `platform_settings`,
-- `market_rate_snapshots` and `scripts` all have live readers whose routes have
-- not been checked for a session. That census is the follow-up; guessing at it
-- under the pressure of a red build is how a public pricing page breaks.
--
-- It DOES report the remaining count as a notice, so the number stays visible
-- instead of being forgotten the moment this file goes green.

do $$
declare
  still_public   text[];
  remaining_all  int;
  unreferenced   text[] := array[
    'ai_prompt_templates', 'demo_persona_contacts', 'journey_tools',
    'long_form_videos', 'marketing_stats', 'playbooks',
    'transparency_videos', 'user_roles'
  ];
begin
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   still_public
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polpermissive
    and  p.polcmd = 'r'
    and  0 = any(p.polroles)
    and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true'
    and  c.relname = any(unreferenced);

  if array_length(still_public, 1) is not null then
    raise exception
      'm414: % polic(ies) on tables NOTHING reads still grant SELECT to PUBLIC: %. PUBLIC includes `anon`, the key shipped in the browser bundle, and `anon` holds Supabase''s default GRANT ALL on these tables — RLS is the only thing in the way and `USING (true)` says yes to every row. These eight have zero readers anywhere in app/, lib/, components/ or services/, so there is no caller to protect and no reason to leave them open. One of them is `playbooks`: its rows carry a NULL content column today, which is the only reason this is not already the leak the wave-28 ruling was written about.',
      array_length(still_public, 1), array_to_string(still_public, ', ');
  end if;

  -- Visible, not enforced. See the header for why this is a notice.
  select count(*) into remaining_all
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polpermissive
    and  p.polcmd = 'r'
    and  0 = any(p.polroles)
    and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true';

  raise notice 'm414: the 8 unreferenced tables are off the open internet. % SELECT-true-to-PUBLIC polic(ies) REMAIN across the schema — each has at least one live reader whose route has not been checked for a session, so they need a per-call-site census, not a sweep. None of the tables involved carries a brokerage_id, so this is platform data rather than tenant data.',
    remaining_all;
end $$;
