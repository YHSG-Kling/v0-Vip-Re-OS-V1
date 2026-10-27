-- WRITTEN, NOT APPLIED (wave 145, lane 145D) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m862 — GOOGLE ADS' CREDENTIAL HAS ITS OWN NAME: 'google_ads' (wave 145, lane 145D; owner ruling 13, 2026-10-27:
-- "ads = meta (facebook/instagram ARE meta), google ads, tv via vibe …" and "stop hallucinating; verify at HEAD").
--
-- THE DEFECT, VERIFIED AT b364eb4b. The ads workspace offers "Connect Google Ads"
-- (app/dashboard/campaigns/ads/ads-dashboard-client.tsx → /api/integrations/oauth/google_ads). The OAuth callback
-- (app/api/integrations/oauth/[provider]/route.ts) stored the credential under platform 'google' — and the live
-- platform_credentials_platform_check (m609, read back 2026-10-27 from hrvaqgvukzxfskkcrwbt) does NOT admit 'google'.
-- Every Google Ads connection was therefore refused (23514) and the callback answered "Failed to store credentials".
-- 'google' was also the wrong NAME (CLAUDE.md §6): it is the ad_campaigns.platform vocabulary, and the Connection OS
-- folds 'google' onto gmail (lib/integrations/connection-manager.ts PROVIDER_ALIASES). The readers now ask for
-- 'google_ads' through ONE mapping (lib/ads/connection-status.ts adCredentialPlatform); the callback writes
-- 'google_ads' (same lane). Every other value is kept exactly as m609 declared it (no value dropped).
--
-- Live rows before: platform_credentials 0 rows (2026-10-27) — nothing to backfill, nothing to rename.
-- Still WAITING_EXTERNAL after this applies: GOOGLE_ADS_DEVELOPER_TOKEN (Google Ads API Center) and the Google
-- OAuth app's Ads scope — names only, see lane 145D notes.
--
-- Verification after applying:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'platform_credentials_platform_check';      -- must list 'google_ads' and every m609 value
--   then regenerate scripts/check-vocabularies.ts (CLAUDE.md §3) so test:check-vocabulary sees it.
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
    'vibe','openai_ads',
    -- wave 145, lane 145D (this migration)
    'google_ads']));
