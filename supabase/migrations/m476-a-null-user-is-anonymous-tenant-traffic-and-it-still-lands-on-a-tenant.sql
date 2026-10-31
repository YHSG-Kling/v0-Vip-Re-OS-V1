-- m476 — A NULL USER IS ANONYMOUS TENANT TRAFFIC, AND IT STILL LANDS ON A TENANT (#187).
--
-- ai_tool_usage is the single source of record for AI spend. The streaming
-- lanes serve turns with NO authenticated staff seat — a public widget
-- visitor, a D-ID avatar turn — and the ruling is that AI cost ALWAYS belongs
-- to the tenant (brokerage), seat or no seat. Those rows now land with
-- user_id NULL and brokerage_id set (lib/ai/models.ts streamTextRouted,
-- lib/ai/cost-tracking.ts logAIUsage).
--
-- MEASURED before writing: user_id is already nullable (no NOT NULL to drop)
-- and 0 of the 23 live rows carry a null user. What the schema could not say
-- is the half that matters: a row with no user MUST name the tenant that pays
-- for it — a ledger row with neither is spend nobody can be billed for.

comment on column public.ai_tool_usage.user_id is
  'NULL = anonymous tenant traffic (public widget visitor, D-ID avatar turn — no authenticated staff seat). Such rows must carry brokerage_id: AI cost always lands on the tenant.';

alter table public.ai_tool_usage
  drop constraint if exists ai_tool_usage_anon_rows_carry_tenant;
alter table public.ai_tool_usage
  add constraint ai_tool_usage_anon_rows_carry_tenant
  check (user_id is not null or brokerage_id is not null);

do $$
declare n int;
begin
  -- Postcondition: the constraint exists, is validated, and no live row
  -- violates it.
  select count(*) into n from pg_constraint
  where conrelid = 'public.ai_tool_usage'::regclass
    and conname  = 'ai_tool_usage_anon_rows_carry_tenant'
    and convalidated;
  if n <> 1 then
    raise exception 'm476: anon-rows-carry-tenant constraint missing or unvalidated';
  end if;

  select count(*) into n from public.ai_tool_usage
  where user_id is null and brokerage_id is null;
  if n <> 0 then
    raise exception 'm476: % ledger row(s) with neither user nor tenant', n;
  end if;
end $$;
