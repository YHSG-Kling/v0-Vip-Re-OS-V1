-- ============================================================================
-- Migration 1079 — platform_credentials: add 'gmail' (Outlook already exists)
-- ============================================================================

ALTER TABLE public.platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE public.platform_credentials ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform = ANY (ARRAY[
    'dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint','showingtime',
    'mls','zillow','realtor_com','idxbroker',
    'facebook','instagram','linkedin','buffer','heygen','google_flow','did',
    'twilio','telnyx','bandwidth','sinch','vapi','plivo',
    'sendgrid','resend','postmark','mailgun',
    'gmail','outlook',
    'google_calendar',
    'stripe','plaid','lob'
  ]));
