-- m103-platform-credentials-allow-crm-quickbooks.sql
-- The platform_credentials.platform CHECK predates the unified owner-scoped Connection Center and
-- omitted the CRM sync-out providers and QuickBooks — so an owner-scoped CRM connection (and the
-- existing QuickBooks OAuth callback, which upserts platform='quickbooks') were silently rejected
-- by the constraint. Extend the allow-list so platform_credentials can hold every connection the
-- registry (lib/connections/scope.ts CONNECTOR_PROVIDERS) routes through it. Idempotent.

ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;

ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check CHECK (platform = ANY (ARRAY[
    -- transaction / esign
    'dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint',
    -- showings
    'showingtime',
    -- listing / IDX / MLS
    'mls','zillow','realtor_com','idxbroker',
    -- social
    'facebook','instagram','linkedin','buffer',
    -- media / AI
    'heygen','google_flow','did',
    -- phone / sms / voice
    'twilio','telnyx','bandwidth','sinch','vapi','plivo',
    -- email
    'sendgrid','resend','postmark','mailgun','gmail','outlook',
    -- calendar
    'google_calendar',
    -- financial
    'stripe','plaid','lob','quickbooks',
    -- crm (sync-out)
    'gohighlevel','followupboss','lofty','hubspot'
  ]::text[]));
