-- m239 — LISTING STATUS↔STAGE SYNC TRIGGER (the single, un-bypassable enforcement)
-- ─────────────────────────────────────────────────────────────────────────────
-- Drift fixed: listings.lifecycle_stage (the 34-state machine) is written by 5+ code paths
-- (transitionLifecycle chokepoint, overrideListingStage, advanceListingStageService, the orchestrator's
-- local advanceListingStage, intake setters) but listings.status (the coarse market state buyer search /
-- public pages / dashboards read) was only synced on ONE of them. So a listing could reach
-- lifecycle_stage=MLS_ACTIVE while status stayed 'coming_soon' and never surface in buyer search.
--
-- Rather than patch every writer (fragile — the next one forgets), enforce the invariant at the DB: a
-- BEFORE INSERT/UPDATE trigger that maps lifecycle_stage → status at the MARKET-STATE BOUNDARIES only.
-- No code path can bypass it. Intermediate stages leave status untouched (coming_soon holds through
-- OPEN_HOUSE_MARKETING; active through OFFERS/NEGOTIATION; pending through INSPECTION..CLOSING_PREP).
--
-- INVARIANT: the CASE below MUST match lib/listings/listing-status-sync.ts statusForStage() (the
-- unit-tested TS spec). Change both together. All mapped values are valid per the listings.status CHECK
-- ('draft','coming_soon','active','pending','sold','expired','withdrawn').

create or replace function public.sync_listing_status_to_stage()
returns trigger
language plpgsql
as $$
declare
  mapped text;
begin
  mapped := case new.lifecycle_stage
    when 'COMING_SOON_ACTIVE' then 'coming_soon'
    when 'MLS_ACTIVE'         then 'active'
    when 'UNDER_CONTRACT'     then 'pending'
    when 'CLOSED'             then 'sold'
    when 'LIFETIME_CUSTOMER'  then 'sold'
    when 'LISTING_EXPIRED'    then 'expired'
    when 'LISTING_CANCELLED'  then 'withdrawn'
    when 'SELLER_DECLINED'    then 'withdrawn'
    else null  -- intermediate / pre-market stage → do not touch status
  end;

  if mapped is null then
    return new;  -- stage carries no market-state implication; leave status as-is
  end if;

  if tg_op = 'INSERT' then
    -- Only fill status when the inserter left it null/default — never clobber an explicit value.
    if new.status is null then
      new.status := mapped;
    end if;
  elsif tg_op = 'UPDATE' then
    -- Only act when the stage actually CHANGED — a status-only update (stage unchanged) is left alone,
    -- so e.g. a manual 'withdrawn' that does not move the stage still stands.
    if new.lifecycle_stage is distinct from old.lifecycle_stage then
      new.status := mapped;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_listing_status_to_stage on public.listings;
create trigger trg_sync_listing_status_to_stage
  before insert or update on public.listings
  for each row
  execute function public.sync_listing_status_to_stage();

comment on function public.sync_listing_status_to_stage() is
  'm239: keeps listings.status in lockstep with lifecycle_stage at market-state boundaries (mirrors lib/listings/listing-status-sync.ts statusForStage). The single un-bypassable enforcement for the status↔stage invariant.';
