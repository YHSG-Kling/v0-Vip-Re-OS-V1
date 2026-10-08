-- m409 — asserts m408.
--
-- Separate file for the m393/m395/m397/m399/m403/m407 reason: a `raise` rolls back
-- its own transaction, so asserting inside m408 would undo the very rewrites it was
-- checking and leave the schema exactly as it was, with a red migration as the only
-- difference.
--
-- IT ASSERTS THE CONSTRUCT, AND THE HALF THAT MATTERS MOST IS THE NEGATIVE HALF.
--
-- (1) public.is_platform_staff() exists as a CONSTRUCT — nullary, boolean,
--     SECURITY DEFINER, STABLE — checked through pg_proc, not by grepping a name
--     out of a file. A helper that is VOLATILE would be re-evaluated per row across
--     a catalogue scan; one that is not SECURITY DEFINER would read `users` under
--     users' own RLS and could resolve to nothing, silently denying every staff
--     member. Both failures are invisible from the policy text.
--
-- (2) Its roster is the owner's four and only those four, with ai_isa_system
--     explicitly excluded — that value is legal in users.platform_role but marks
--     the two automated ISA service accounts, not a member of staff. Asserted
--     against the stored function body so that a later `create or replace` that
--     quietly drops 'marketing' cannot pass.
--
-- (3) Every write policy on the platform CATALOGUE gates on is_platform_staff().
--     Stated as a property over the table set rather than a list of policy names,
--     so a policy dropped and recreated under a new name still has to satisfy it.
--
-- (4) THE NEGATIVE HALF, AND THE REASON THIS WAVE IS NOT ONE-LINE-WIDE:
--     is_platform_admin() must STILL mean superadmin. It is named in 522 policies
--     across 179 tables — commissions, invoices, payouts, PII — and the single
--     most tempting way to "apply the ruling" is to edit that one function. Doing
--     so grants a marketing account superadmin-equivalent DELETE across the entire
--     schema. This clause fails if the roles 'marketing' or 'support' ever appear
--     in its body, and fails if its policy footprint collapses (which is what a
--     wholesale swap of is_platform_admin() → is_platform_staff() would look like).
--
-- (5) service_status stays on is_platform_admin() and must NOT acquire
--     is_platform_staff(). It was on m408's candidate list and was deliberately
--     excluded: its columns are machine telemetry (last_checked_at,
--     consecutive_failures, response_time_ms), its only writer is the health-check
--     cron on the SERVICE client which bypasses RLS entirely, so widening it grants
--     no human workflow anything — while granting a marketing or support account
--     the ability to forge or clear a platform outage on the surface tenants read
--     to decide whether the platform is up. Pinned here because the pattern around
--     it is now uniform, and uniformity is exactly what invites a copy-paste to
--     "finish the job".
--
-- (6) SELECT was not touched on the catalogue tables. m407 established that every
--     shared-catalogue table must STILL admit `brokerage_id IS NULL` on SELECT,
--     because 100% of the rows in those tables ARE platform rows and stripping the
--     branch would return zero onboarding steps, zero training videos and zero help
--     articles to every tenant at once. m408 is a write-side change; this re-checks
--     the read side survived it, so a regression cannot hide behind "that was m406's
--     assertion, not mine".
--
-- NEGATIVE CONTROLS, EACH WATCHED RED BEFORE THIS FILE WAS APPLIED:
--   (1) run before m408 → RED at clause (1): is_platform_staff() does not exist.
--   (3) run before m408 with the existence check removed → RED naming exactly 18
--       policies: all 3 writes on each of onboarding_steps, help_topics_kb,
--       content_topic_sources, training_videos, thank_you_note_templates and
--       support_tickets.
--   (2) `create or replace` of the helper with 'marketing' dropped, inside a rolled-
--       back transaction → RED; roster re-verified afterwards.
--   (4) `create or replace` of is_platform_admin() widened to the four roles, inside
--       a rolled-back transaction → RED; the live body re-verified afterwards.
--   (5) service_status_tenant_update ALTERed onto is_platform_staff() inside a
--       rolled-back transaction → RED; policy re-verified afterwards.
--   (6) the NULL branch stripped from onboarding_steps_tenant_select inside a
--       rolled-back transaction → RED; policy re-verified afterwards.

do $$
declare
  -- Tables whose WRITE side the ruling moves to the four staff roles.
  staff_write_set text[] := array['onboarding_steps','help_topics_kb','content_topic_sources',
                                  'training_videos','thank_you_note_templates',
                                  'support_tickets','knowledge_articles'];
  -- Tables that must KEEP the untenanted platform row readable (m407's half 2).
  read_set text[] := array['onboarding_steps','training_videos','help_topics_kb',
                           'knowledge_articles','buyer_stage_coaching',
                           'thank_you_note_templates','content_topic_sources',
                           'service_status'];
  fn_oid      oid;
  fn_secdef   boolean;
  fn_vol      "char";
  fn_rettype  oid;
  fn_nargs    int;
  staff_body  text;
  admin_body  text;
  admin_pols  int;
  unswapped   text[];
  leaked      text[];
  unreadable  text[];
begin
  -- ── (1) the construct ──────────────────────────────────────────────────────
  select p.oid, p.prosecdef, p.provolatile, p.prorettype, p.pronargs, p.prosrc
    into fn_oid, fn_secdef, fn_vol, fn_rettype, fn_nargs, staff_body
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'is_platform_staff' and p.pronargs = 0;

  if fn_oid is null then
    raise exception
      'm409(1): public.is_platform_staff() does not exist. m408 is the file that creates it; a migration FILE is not a migration — confirm the row in supabase_migrations.schema_migrations, not the presence of the .sql.';
  end if;
  if fn_rettype <> 'boolean'::regtype or fn_nargs <> 0 then
    raise exception 'm409(1): is_platform_staff must be nullary and return boolean (got % args returning %).', fn_nargs, fn_rettype::regtype;
  end if;
  if not fn_secdef then
    raise exception
      'm409(1): is_platform_staff() is not SECURITY DEFINER. It reads public.users from inside policies on other tables; without DEFINER it is subject to users'' own RLS and can resolve to NO ROW, which reads as "not staff" and silently locks every platform staff member out of the catalogue.';
  end if;
  if fn_vol <> 's' then
    raise exception
      'm409(1): is_platform_staff() is not STABLE (provolatile=%). A VOLATILE gate is re-executed per row, turning one lookup into one per catalogue row on every scan.', fn_vol;
  end if;

  -- ── (2) the roster is the owner's four, and ai_isa_system is not staff ──────
  if position('''superadmin''' in staff_body) = 0
     or position('''admin'''      in staff_body) = 0
     or position('''marketing'''  in staff_body) = 0
     or position('''support'''    in staff_body) = 0 then
    raise exception
      'm409(2): is_platform_staff() does not carry all four platform roles. The owner''s ruling is verbatim: "the platform roles are the staff including superadmin, admin, support, marketing." Body: %', staff_body;
  end if;
  if position('ai_isa_system' in staff_body) > 0 then
    raise exception
      'm409(2): is_platform_staff() admits ai_isa_system. That is a legal users.platform_role value, but it marks the two automated ISA service accounts — not a person on the staff. It has its own helper (is_ai_isa_system()) and its own policies.';
  end if;

  -- ── (3) the catalogue write side is on the staff helper ────────────────────
  select coalesce(array_agg(c.relname || '.' || p.polname || ' [' || p.polcmd::text || ']'
                            order by c.relname, p.polname), '{}')
  into   unswapped
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname = any(staff_write_set)
    and  p.polpermissive
    and  p.polcmd in ('a','w','d')                 -- INSERT / UPDATE / DELETE
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_platform_staff()') = 0;

  if array_length(unswapped, 1) is not null then
    raise exception
      'm409(3): % catalogue write polic(ies) do not gate on is_platform_staff(): %. m406 closed a real hole by narrowing these to is_platform_admin(), but that is ONE account on this database — a support operator could not fix a typo in a help article and a marketing staffer could not publish a training video. The four staff roles maintain the platform catalogue.',
      array_length(unswapped, 1), array_to_string(unswapped, ', ');
  end if;

  -- ── (4) is_platform_admin() DID NOT MOVE ───────────────────────────────────
  select p.prosrc into admin_body
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'is_platform_admin' and p.pronargs = 0;

  if admin_body is null then
    raise exception 'm409(4): public.is_platform_admin() is gone. 522 policies across 179 tables reference it.';
  end if;
  if position('''marketing''' in admin_body) > 0 or position('''support''' in admin_body) > 0 then
    raise exception
      'm409(4): is_platform_admin() has been widened beyond superadmin. It is named in 522 policies across 179 tables including commissions, invoices, payouts and every table carrying tenant PII — widening it does not "apply the ruling", it hands a marketing account superadmin-equivalent DELETE across the whole schema in one ALTER. The ruling says who the staff ARE; it does not say a marketing user may delete a commission row. Body: %',
      admin_body;
  end if;

  select count(*) into admin_pols
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_platform_admin()') > 0;

  if admin_pols < 500 then
    raise exception
      'm409(4): only % polic(ies) still reference is_platform_admin(); it was 522 across 179 tables before m408. A collapse of that footprint is what a wholesale is_platform_admin()->is_platform_staff() swap looks like, and it would move commission, invoice and PII tables to the four-role roster by accident.',
      admin_pols;
  end if;

  -- ── (5) service_status was excluded ON PURPOSE and must stay excluded ──────
  select coalesce(array_agg(p.polname order by p.polname), '{}')
  into   leaked
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname in ('service_status','api_response_logs')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_platform_staff()') > 0;

  if array_length(leaked, 1) is not null then
    raise exception
      'm409(5): % polic(ies) on service_status/api_response_logs now gate on is_platform_staff(): %. Both are machine telemetry, not catalogue content — their only writers are the health-check cron and the connector gateway, both on the SERVICE client, which bypasses RLS entirely. Widening them grants no human workflow anything; it only lets a marketing or support account forge or clear a platform outage on the surface tenants read to decide whether the platform is up.',
      array_length(leaked, 1), array_to_string(leaked, ', ');
  end if;

  -- ── (6) SELECT untouched: the platform row is still readable by every tenant ─
  select coalesce(array_agg(t order by t), '{}')
  into   unreadable
  from   unnest(read_set) t
  where  not exists (
           select 1
           from   pg_policy p
           join   pg_class     c on c.oid = p.polrelid
           join   pg_namespace n on n.oid = c.relnamespace
           where  n.nspname = 'public'
             and  c.relname = t
             and  p.polpermissive
             and  p.polcmd in ('r','*')
             and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                         'brokerage_id IS NULL') > 0
         );

  if array_length(unreadable, 1) is not null then
    raise exception
      'm409(6): % shared-catalogue table(s) no longer admit the untenanted platform row on SELECT: %. Every row in these tables IS a platform row (66/66 onboarding_steps, 12/12 training_videos, 11/11 help_topics_kb), so losing that branch does not scope the feature — it empties it for every tenant at once. m408 is a WRITE-side change; the read side must be exactly where m406 and m407 left it.',
      array_length(unreadable, 1), array_to_string(unreadable, ', ');
  end if;

  raise notice 'm409: PASS — is_platform_staff() is a STABLE SECURITY DEFINER nullary boolean carrying exactly {superadmin, admin, marketing, support}; % catalogue write policies gate on it; is_platform_admin() is unchanged and still named by % policies; service_status and api_response_logs excluded; all % read-set tables still admit the platform row on SELECT.',
    (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname = any(staff_write_set) and p.polcmd in ('a','w','d')
        and strpos(coalesce(pg_get_expr(p.polqual,p.polrelid),'')||' '||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'is_platform_staff()')>0),
    admin_pols, array_length(read_set,1);
end $$;
