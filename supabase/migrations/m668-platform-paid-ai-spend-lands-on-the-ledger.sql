-- ── APPLIED LIVE 2026-09-27 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
-- m668 — PLATFORM-PAID AI SPEND LANDS ON THE LEDGER (wave 86, lane 86D)
--
-- Owner (wave 86): "keep provider cost down (Vercel AI SDK + AI Gateway)".
-- A cost nobody books cannot be kept down.
--
-- THE BLIND SPOT. The platform's OWN AI agents — the website prospect chat
-- (app/api/platform/prospect-chat), the platform phone receptionist
-- (lib/voice/twilio-voice.ts planReceptionTurn deployment "platform") and the
-- platform live avatar (app/api/did/custom-llm handlePlatformTurn) — serve
-- prospects who have no tenant. Their model calls pass brokerageId: null, and
-- both routed lanes only write the ledger `if (request.brokerageId)`. Even had
-- they tried, m476's ai_tool_usage_anon_rows_carry_tenant
-- (user_id IS NOT NULL OR brokerage_id IS NOT NULL) refuses a row with neither
-- — correct for TENANT traffic, but platform traffic has no tenant by
-- definition. Both route headers claimed the spend was "booked under the
-- data_steward manager on ai_tool_usage"; it was booked nowhere. Public,
-- unauthenticated, uncapped (fair-use needs a tenant) AND unmeasured.
--
-- MEASURED LIVE before writing (hrvaqgvukzxfskkcrwbt, 2026-09-27):
--   · ai_tool_usage: 23 rows, 0 with brokerage_id NULL, no platform_paid column;
--   · CHECKs: ai_tool_usage_anon_rows_carry_tenant, _model_is_priceable,
--     _tokens_name_their_model;
--   · the tenant SELECT / UPDATE / DELETE policies all read
--     `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`
--     — so the moment a null-tenant row exists, EVERY authenticated tenant
--     user could read it and delete it. Harmless while 0 such rows exist; it
--     would expose (and let a tenant erase) the platform's own AI cost ledger
--     the day this lane's rows start landing. Tightened below in the same step.
--
-- WHY A FLAG AND NOT THE SHOWCASE TENANT. lib/did/platform-live-agent.ts books
-- platform D-ID MINUTES under the never-billed showcase tenant. Doing the same
-- for tokens would run logAIUsage's tenant rails on that brokerage —
-- usage_counters.ai_tokens_monthly (the FAIR-USE CAP), ai_usage_monthly and
-- billing_usage — so prospect traffic would eat the showcase tenant's cap and
-- a busy sales day could start refusing the platform's own demo. A platform
-- row is not tenant spend; it is its own class.

alter table public.ai_tool_usage
  add column if not exists platform_paid boolean not null default false;

comment on column public.ai_tool_usage.platform_paid is
  'TRUE = the platform''s own AI agents serving a prospect with no tenant (prospect chat, platform voice line, platform live avatar). Such rows carry brokerage_id NULL, never touch a tenant''s counters/caps/invoice, and are read by lib/platform/manager-ops.ts (loadPlatformPaidAiSpend). Written only by lib/ai/cost-tracking.ts logAIUsage via lib/ai/models.ts routed lanes (RoutedTextRequest.platformPaid).';

-- m476's rule, widened by exactly one arm: a row with neither user nor tenant
-- is legal ONLY when it declares itself platform-paid.
alter table public.ai_tool_usage
  drop constraint if exists ai_tool_usage_anon_rows_carry_tenant;
alter table public.ai_tool_usage
  add constraint ai_tool_usage_anon_rows_carry_tenant
  check (user_id is not null or brokerage_id is not null or platform_paid);

-- And the converse: a platform-paid row never names a tenant (it would then be
-- billed to one by every tenant-keyed rollup).
alter table public.ai_tool_usage
  drop constraint if exists ai_tool_usage_platform_paid_has_no_tenant;
alter table public.ai_tool_usage
  add constraint ai_tool_usage_platform_paid_has_no_tenant
  check (not platform_paid or brokerage_id is null);

-- Tenant policies: the `brokerage_id IS NULL` arm admitted EVERY null-tenant
-- row to EVERY tenant. Keep a null-tenant row visible only to the user who
-- produced it (a background job run under that user's seat), never a
-- platform-paid row. Platform staff read platform spend on the service client
-- (manager-ops), which bypasses RLS.
drop policy if exists ai_tool_usage_tenant_select on public.ai_tool_usage;
create policy ai_tool_usage_tenant_select on public.ai_tool_usage
  for select to authenticated
  using (
    brokerage_id = current_user_brokerage_id()
    or (brokerage_id is null and not platform_paid and user_id = (select auth.uid()))
  );

drop policy if exists ai_tool_usage_tenant_update on public.ai_tool_usage;
create policy ai_tool_usage_tenant_update on public.ai_tool_usage
  for update to authenticated
  using (
    brokerage_id = current_user_brokerage_id()
    or (brokerage_id is null and not platform_paid and user_id = (select auth.uid()))
  )
  with check (
    brokerage_id = current_user_brokerage_id()
    or (brokerage_id is null and not platform_paid and user_id = (select auth.uid()))
  );

-- INSERT: neither tenant insert policy may mint a platform-paid row (only the
-- service-client ledger writer does). Both were `TO public` live (anon
-- included — the m394/scripts/rls-anon-tenant-escape-guard.ts shape) and the
-- tenant one carried the bare `brokerage_id IS NULL OR` arm; recreated here as
-- a STRICT narrowing: TO authenticated, the null-tenant arm limited to the
-- caller's own non-platform row, is_tenant_staff_seat() kept.
drop policy if exists ai_tool_usage_tenant_insert on public.ai_tool_usage;
create policy ai_tool_usage_tenant_insert on public.ai_tool_usage
  for insert to authenticated
  with check (
    (
      brokerage_id = current_user_brokerage_id()
      or (brokerage_id is null and not platform_paid and user_id = (select auth.uid()))
    )
    and is_tenant_staff_seat()
    and not platform_paid
  );

drop policy if exists "Users can insert their own AI usage" on public.ai_tool_usage;
create policy "Users can insert their own AI usage" on public.ai_tool_usage
  for insert to authenticated
  with check (user_id = (select auth.uid()) and not platform_paid);

drop policy if exists ai_tool_usage_tenant_delete on public.ai_tool_usage;
create policy ai_tool_usage_tenant_delete on public.ai_tool_usage
  for delete to authenticated
  using (
    brokerage_id = current_user_brokerage_id()
    or (brokerage_id is null and not platform_paid and user_id = (select auth.uid()))
  );

do $$
declare n int;
begin
  -- Postconditions: both CHECKs exist and are validated; no live row violates
  -- either; no tenant policy still admits a bare `brokerage_id IS NULL`.
  select count(*) into n from pg_constraint
  where conrelid = 'public.ai_tool_usage'::regclass
    and conname in ('ai_tool_usage_anon_rows_carry_tenant', 'ai_tool_usage_platform_paid_has_no_tenant')
    and convalidated;
  if n <> 2 then
    raise exception 'm668: expected 2 validated ai_tool_usage CHECKs, found %', n;
  end if;

  select count(*) into n from public.ai_tool_usage
  where user_id is null and brokerage_id is null and not platform_paid;
  if n <> 0 then
    raise exception 'm668: % ledger row(s) with neither user nor tenant nor platform flag', n;
  end if;

  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = 'ai_tool_usage'
    and policyname in ('ai_tool_usage_tenant_select', 'ai_tool_usage_tenant_update', 'ai_tool_usage_tenant_delete')
    and coalesce(qual, '') ~ '^\(?\(brokerage_id IS NULL\) OR';
  if n <> 0 then
    raise exception 'm668: % tenant polic(ies) still admit every null-tenant row', n;
  end if;
end $$;
