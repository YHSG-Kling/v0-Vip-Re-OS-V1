-- m161 — tier scope on direct_mail_presets + campaign_bundles.
--
-- Drift correction: Wave 36 shipped direct_mail_presets and Wave 37
-- shipped campaign_bundles with brokerage_id only. The platform's
-- canonical subscription tiers are solo_agent / team / brokerage /
-- multi_location — agents should be able to own their own presets +
-- bundles (their voice, their farm), teams should be able to own
-- team-level ones, brokerages own the house templates. Same cascade
-- the rest of the OS uses.
--
-- Pattern (scope_type + scope_id) is the canonical Wave 27/28 +
-- Wave 32 shape used by lifecycle_promo_policy + blog_cadence_policy.
-- Keeps the policy-scope resolver (lib/identity/policy-scope.ts) able
-- to gate reads + writes the same way for every preset / bundle.
--
-- Backwards compatibility: existing rows are migrated by stamping
-- scope_type='brokerage' + scope_id=brokerage_id. brokerage_id stays
-- as the canonical tenant id so RLS-style multi-tenant queries
-- continue to work.

alter table public.direct_mail_presets
  add column if not exists scope_type text default 'brokerage'
    check (scope_type in ('agent', 'team', 'brokerage')),
  add column if not exists scope_id   uuid;

-- Backfill existing rows.
update public.direct_mail_presets
  set scope_type = 'brokerage', scope_id = brokerage_id
  where scope_id is null;

alter table public.direct_mail_presets
  alter column scope_id set not null;

create index if not exists idx_direct_mail_presets_scope
  on public.direct_mail_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

-- Same pattern for campaign_bundles.
alter table public.campaign_bundles
  add column if not exists scope_type text default 'brokerage'
    check (scope_type in ('agent', 'team', 'brokerage')),
  add column if not exists scope_id   uuid;

update public.campaign_bundles
  set scope_type = 'brokerage', scope_id = brokerage_id
  where scope_id is null;

alter table public.campaign_bundles
  alter column scope_id set not null;

create index if not exists idx_campaign_bundles_scope
  on public.campaign_bundles (brokerage_id, scope_type, scope_id)
  where is_active = true;

-- multi_location is NOT in the scope_type CHECK because multi_location
-- subscribers' bundles + presets live at the BROKERAGE tier (one row
-- per office is the right granularity — a multi_location with 6
-- offices has 6 brokerages rows). The tier subscription itself is on
-- brokerages.subscription_tier (existing column); we don't need a
-- separate scope_type for it.

comment on column public.direct_mail_presets.scope_type is 'Wave 37 tier scope: agent / team / brokerage. Resolver cascades agent → team → brokerage when looking up applicable presets.';
comment on column public.campaign_bundles.scope_type    is 'Wave 37 tier scope: agent / team / brokerage. Same cascade semantic as direct_mail_presets.';
