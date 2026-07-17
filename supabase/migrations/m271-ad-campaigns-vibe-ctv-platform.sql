-- m271-ad-campaigns-vibe-ctv-platform.sql
-- STREAMING-TV AD LANE (Vibe.co CTV): ad_campaigns.platform carries a CHECK from the
-- social-ads era (facebook/instagram/google) that silently rejects the new 'vibe_ctv'
-- staging insert (lib/ads/ctv-campaign.ts). Widen it to the platform vocabulary the
-- code already uses (lib/kernel/ads.ts AdPlatform: facebook|instagram|google|linkedin|
-- tiktok) plus 'vibe_ctv' — the staged streaming-TV lane. The original constraint name
-- varies across environments, so drop whatever CHECK mentions platform (m176 pattern)
-- and re-add one canonical constraint.
--
-- NOTE: this migration has NOT been applied by the authoring session (no migration
-- access). Until it is applied, stageCtvCampaign surfaces the CHECK rejection as an
-- honest error naming this file instead of writing the row.
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
    where conrelid = 'public.ad_campaigns'::regclass and contype = 'c'
      -- Match ONLY the CHECK on the platform COLUMN. A bare '%platform%' would
      -- also drop the visibility_scope CHECK (its array contains 'platform').
      and pg_get_constraintdef(oid) like '%platform = ANY%'
  loop
    execute format('alter table public.ad_campaigns drop constraint %I', cname);
  end loop;
  execute 'alter table public.ad_campaigns add constraint ad_campaigns_platform_check
    check (platform = any (array[''facebook'',''instagram'',''google'',''linkedin'',''tiktok'',''vibe_ctv'']))';
end $$;

comment on column public.ad_campaigns.platform is
  'Ad platform this campaign targets. Social platforms dispatch through lib/ads/connectors; vibe_ctv is the streaming-TV lane — staged as a launch package (lib/ads/ctv-campaign.ts) until Vibe API dispatch access exists (lib/providers/vibe.ts).';
