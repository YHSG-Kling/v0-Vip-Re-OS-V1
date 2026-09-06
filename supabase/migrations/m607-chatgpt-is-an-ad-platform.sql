-- m607 — ChatGPT is an ad platform a campaign may target.
--
-- Owner, 2026-09-06: "looks like from billy is that ads are now available with
-- chatgpt." The ads workspace and the Ads Manager plan campaigns against
-- ad_campaigns.platform, whose CHECK admitted six platforms. This adds
-- 'chatgpt' beside them. Like google / tiktok / vibe_ctv it has NO account
-- connection in the Connection OS yet (lib/integrations/ad-campaign-vocabulary.ts
-- AD_PLATFORMS_WITHOUT_CONNECTIONS) — a campaign is planned and staged as a
-- launch package until a dispatch path exists.
--
-- APPLIED 2026-09-06 (Supabase MCP, project hrvaqgvukzxfskkcrwbt) and the
-- constraint read back as admitting the seven values below; the vocabulary
-- cache was regenerated from the live constraints the same day (CLAUDE.md §3).
--
-- The ADD CONSTRAINT is a plain statement, not an `execute` string as in m271:
-- scripts/vocabulary-snapshot-guard.ts reads the declared ARRAY out of the
-- migration text and cannot see values inside a dollar-quoted execute string.
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
end $$;

alter table public.ad_campaigns add constraint ad_campaigns_platform_check
  check (platform = any (array['facebook', 'instagram', 'google', 'linkedin', 'tiktok', 'vibe_ctv', 'chatgpt']));

comment on column public.ad_campaigns.platform is
  'Ad platform this campaign targets. Social platforms dispatch through lib/ads/connectors; vibe_ctv is the streaming-TV lane and chatgpt the ChatGPT Ads lane — both staged as launch packages until an API dispatch path exists.';
