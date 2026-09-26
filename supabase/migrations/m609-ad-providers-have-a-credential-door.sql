-- m609 — AD PROVIDERS HAVE A CREDENTIAL DOOR (2026-09-07)
--
-- lib/providers/vibe.ts (streaming TV) and lib/providers/openai-ads.ts (ChatGPT
-- Ads, developers.openai.com/ads) both RESOLVE a brokerage credential through
-- the Connection OS under providers 'vibe' and 'openai_ads'. The one tenant
-- credential writer (app/actions/tenant-connections.ts saveTenantConnectionAction)
-- inserts into platform_credentials, whose platform CHECK (m354) admits neither
-- name — so both readers were WRITERLESS: an insert of either would be refused
-- with 23514 and every launch precheck answered "not connected" forever.
-- §1.2: no duplicate exists and the capability is wanted → BUILD the door.
--
-- APPLIED 2026-09-07 to hrvaqgvukzxfskkcrwbt by the integrator; the vocabulary
-- cache (scripts/check-vocabularies.ts) was regenerated from the live database
-- in the same wave.
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
    -- ad providers (this migration)
    'vibe','openai_ads']));
