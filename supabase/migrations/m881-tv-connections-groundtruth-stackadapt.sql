-- ── APPLIED LIVE 2026-10-29 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 146, lane 146E ──
--
-- m881 — THE TWO TV CONNECTIONS HAVE NAMES THE DATABASE ADMITS (wave 146, lane 146E; owner ruling 8, 2026-10-29:
-- "groundtruth (https://api-docs.groundtruth.com/) and stackadapt are 2 tv connections").
--
-- WHAT THE CODE NOW WRITES (and the live CHECKs, read back 2026-10-29 from hrvaqgvukzxfskkcrwbt, refuse):
--   · ad_campaigns.platform 'groundtruth' / 'stackadapt' — the ONE TV gateway (lib/ads/ctv-campaign.ts stageCtvCampaign,
--     tvPlatform) stages a TV spot on either; live CHECK admits facebook, instagram, google, linkedin, tiktok, vibe_ctv,
--     chatgpt only (23514 today — the gateway names this file in its refusal).
--   · platform_credentials.platform 'groundtruth' / 'stackadapt' — the tenant connection slots
--     (lib/settings/tenant-connection-slots.ts → app/actions/tenant-connections.ts) store the vendor-issued credential
--     under the provider's canonical name; the Connection OS resolves it (resolveGroundtruthCredential /
--     resolveStackadaptCredential). Live CHECK: the 56 values below (m862 + nothing since).
--   · facebook_custom_audiences.target_platform 'stackadapt' — a consented CRM audience can sync to StackAdapt as a
--     hashed CRM segment (lib/ads/connectors/stackadapt.ts pushCustomAudience; syncAudience runs every consent /
--     fair-housing / persona / source-rule gate first). GroundTruth publishes no audience upload, so it is NOT added.
--
-- Every live value is KEPT exactly as read (no value dropped). Live rows before (2026-10-29): ad_campaigns 2 (both
-- facebook), platform_credentials 0, facebook_custom_audiences 0 — nothing to backfill or rename.
--
-- Verification after applying:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('ad_campaigns_platform_check','platform_credentials_platform_check',
--                      'facebook_custom_audiences_target_platform_check');
--   → each lists every value below; then regenerate scripts/check-vocabularies.ts (CLAUDE.md §3) so
--     test:check-vocabulary and test:deconflict-channel (AD_CAMPAIGN_PLATFORMS member-for-member) read the new values.
-- Rollback (only while no row carries the new values): re-run the three blocks without the wave-146 values.

ALTER TABLE public.ad_campaigns
  DROP CONSTRAINT IF EXISTS ad_campaigns_platform_check;
ALTER TABLE public.ad_campaigns
  ADD CONSTRAINT ad_campaigns_platform_check
  CHECK (platform = ANY (ARRAY[
    'facebook','instagram','google','linkedin','tiktok','vibe_ctv','chatgpt',
    -- wave 146, lane 146E (this migration)
    'groundtruth','stackadapt']));

ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform = ANY (ARRAY[
    'dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint',
    'showingtime','mls','zillow','realtor_com','idxbroker','listhub','mls_direct',
    'opcity','facebook','instagram','linkedin','buffer','platform_social_facebook',
    'platform_social_instagram','platform_social_linkedin','platform_social_x',
    'platform_social_tiktok','platform_social_youtube','google_flow','did','pexels',
    'twilio','telnyx','bandwidth','sinch','plivo','twilio_subaccount','twilio_byo',
    'twilio_a2p','sendgrid','resend','postmark','mailgun','gmail','outlook',
    'google_calendar','zoom','stripe','plaid','lob','quickbooks','gohighlevel',
    'followupboss','lofty','hubspot','platform_quickbooks','platform_zoom',
    'vibe','openai_ads','google_ads',
    -- wave 146, lane 146E (this migration)
    'groundtruth','stackadapt']));

ALTER TABLE public.facebook_custom_audiences
  DROP CONSTRAINT IF EXISTS facebook_custom_audiences_target_platform_check;
ALTER TABLE public.facebook_custom_audiences
  ADD CONSTRAINT facebook_custom_audiences_target_platform_check
  CHECK (target_platform = ANY (ARRAY[
    'facebook','instagram','google','linkedin','tiktok',
    -- wave 146, lane 146E (this migration)
    'stackadapt']));
