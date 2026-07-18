-- m273-platform-social-credentials.sql
-- COMPANY-CHANNEL CREDENTIAL HOME. The OS markets ITSELF (platform_social_drafts →
-- the growth board), but the platform's own social accounts had nowhere to keep
-- tokens: platform_credentials required a brokerage_id (the platform has none) and
-- its platform CHECK predates platform-owned social. The m102 owner-scope model
-- already anticipates owner_type='platform' — this migration lets the table honor it:
--
--   1. brokerage_id becomes nullable — owner_type/owner_id is the real key (m104
--      unique index); platform-owned rows have NO tenant. Tenant writers still
--      supply brokerage_id; nothing else changes for them.
--   2. The platform CHECK gains DISTINCT 'platform_social_<channel>' keys for the
--      company channels. Deliberately NOT the tenant provider ids ('facebook',
--      'linkedin', …): the scope cascade (lib/connections/scope.ts) falls back to
--      owner_type='platform' for every tenant, so reusing tenant ids would let a
--      brokerage with no social connection resolve — and post through — the
--      COMPANY's account. Distinct keys make that impossible by construction.
--
-- platform_social_accounts.credential_ref points at these rows (tokens NEVER live
-- in platform_social_accounts itself). Idempotent.

ALTER TABLE public.platform_credentials
  ALTER COLUMN brokerage_id DROP NOT NULL;

ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;

ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check CHECK (platform = ANY (ARRAY[
    -- transaction / esign
    'dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint',
    -- showings
    'showingtime',
    -- listing / IDX / MLS
    'mls','zillow','realtor_com','idxbroker','listhub','mls_direct','opcity',
    -- social (tenant-connectable)
    'facebook','instagram','linkedin','buffer',
    -- media / AI
    'heygen','google_flow','did','pexels',
    -- phone / sms / voice
    'twilio','telnyx','bandwidth','sinch','vapi','plivo','twilio_subaccount','twilio_byo','twilio_a2p',
    -- email
    'sendgrid','resend','postmark','mailgun','gmail','outlook',
    -- calendar
    'google_calendar',
    -- financial
    'stripe','plaid','lob','quickbooks',
    -- crm (sync-out)
    'gohighlevel','followupboss','lofty','hubspot',
    -- THE PLATFORM'S OWN COMPANY CHANNELS (owner_type='platform' only; distinct keys
    -- so the tenant scope-cascade can never resolve the company's tokens)
    'platform_social_facebook','platform_social_instagram','platform_social_linkedin',
    'platform_social_x','platform_social_tiktok','platform_social_youtube'
  ]::text[]));
