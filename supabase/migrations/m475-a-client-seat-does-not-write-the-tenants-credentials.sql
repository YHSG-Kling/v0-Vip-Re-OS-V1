-- m475 — A CLIENT SEAT DOES NOT WRITE THE TENANT'S CREDENTIALS (#180, stratum S3).
--
-- #180 measured 195 INSERT policies that pin a tenant and test NO role. That
-- population is NOT one stratum: a contact inserting an `offers` row can be the
-- buyer portal working as designed, so a blanket role test would break real
-- flows. This migration closes the stratum where no defensible client flow can
-- exist: the FIVE credential/connection tables. VERIFIED by grep before
-- writing: every live writer of these tables is a staff-side action or cron —
-- no portal or client surface writes them.
--
--   agent_api_credentials, integration_credentials, platform_credentials,
--   calendar_provider_accounts, social_media_accounts
--
-- Today their writes are bare-tenant: any authenticated user IN the brokerage —
-- including a contact, lender or vendor seat — may INSERT/UPDATE/DELETE rows
-- holding API keys and OAuth tokens. A seat that exists to SEE ITS OWN DEALS
-- could plant or replace the brokerage's credentials.
--
-- ── THE SEAT ROSTER, DERIVED NOT INVENTED ────────────────────────────────────
-- is_tenant_staff_seat() = the storable user_types MINUS the client-class seats
-- the owner ruled see only their own work (contact, lender, vendor) and MINUS
-- 'system' (the AI-ISA service accounts write through the service role, which
-- RLS does not bind — excluding them here costs nothing and keeps the seat
-- roster human). This is a WORKING-SEAT test, deliberately wider than
-- is_brokerage_admin(): an agent connecting their own Google Calendar is the
-- product working; a contact connecting anything is not.
create or replace function public.is_tenant_staff_seat()
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    (select user_type in ('agent','isa','tc','team_lead','broker','broker_owner',
                          'admin','compliance_officer','title_agent','support','superadmin')
     from public.users where id = auth.uid() limit 1),
    false
  );
$$;

comment on function public.is_tenant_staff_seat() is
  'WORKING-SEAT test: the caller holds a staff user_type (not contact/lender/vendor/system). Wider than is_brokerage_admin() — this asks "may this seat operate the product", not "may it administer the brokerage". Introduced by m475 for the credential-table writes; compose it with a tenant pin, never alone.';

-- Tighten every WRITE policy on the five tables: same tenant pin, plus the seat.
do $$
declare r record; n int := 0;
begin
  for r in
    select tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname='public'
      and tablename in ('agent_api_credentials','integration_credentials','platform_credentials',
                        'calendar_provider_accounts','social_media_accounts')
      and cmd in ('INSERT','UPDATE','DELETE')
  loop
    -- Precondition per policy: bare-tenant as measured. If a policy already
    -- carries a role test, FAIL LOUDLY rather than silently rewriting a rule
    -- someone else authored.
    if coalesce(r.qual, r.with_check) ~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|auth\.uid' then
      raise exception 'm475: %.% already carries an identity test — refusing to rewrite blind', r.tablename, r.policyname;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    if r.cmd = 'INSERT' then
      execute format(
        'create policy %I on public.%I for insert with check ((%s) and public.is_tenant_staff_seat())',
        r.policyname, r.tablename, r.with_check);
    elsif r.cmd = 'UPDATE' then
      execute format(
        'create policy %I on public.%I for update using ((%s) and public.is_tenant_staff_seat()) with check ((%s) and public.is_tenant_staff_seat())',
        r.policyname, r.tablename, r.qual, coalesce(r.with_check, r.qual));
    else
      execute format(
        'create policy %I on public.%I for delete using ((%s) and public.is_tenant_staff_seat())',
        r.policyname, r.tablename, r.qual);
    end if;
    n := n + 1;
  end loop;
  raise notice 'm475: tightened % write policies', n;
  if n < 10 then
    raise exception 'm475: expected at least 10 write policies across five tables, rewrote only %', n;
  end if;
end $$;

-- Postcondition: no write policy on these tables is bare-tenant any more.
do $$
declare v_bad int;
begin
  select count(*) into v_bad from pg_policies
  where schemaname='public'
    and tablename in ('agent_api_credentials','integration_credentials','platform_credentials',
                      'calendar_provider_accounts','social_media_accounts')
    and cmd in ('INSERT','UPDATE','DELETE')
    and coalesce(qual, with_check) !~ 'is_tenant_staff_seat';
  if v_bad <> 0 then
    raise exception 'm475: % write policies remain without the seat test', v_bad;
  end if;
end $$;
