-- ============================================================================
-- Migration 1067 — Allow new provider platforms in platform_credentials.platform
-- ============================================================================
--
-- WHY:
--   Per Sprint-14 M.3 ("providers may not be Twilio — depends on user settings"),
--   the SMS dispatcher now supports Twilio, Telnyx, and Bandwidth. The existing
--   platform_credentials.platform CHECK constraint did not include telnyx /
--   bandwidth, blocking brokerages from storing credentials for those providers.
--
-- WHAT:
--   Extends the CHECK to include the SMS provider catalog we now support and
--   common call providers (vapi, plivo) so AI ISA call-provider routing can
--   also be configured per brokerage in future without another migration.
-- ============================================================================

BEGIN;

ALTER TABLE public.platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE public.platform_credentials ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform = ANY (ARRAY[
    -- Transaction / e-sign
    'dotloop','docusign','skyslope','authentisign','formsimplicity','brokermint',
    -- Real estate aggregators / MLS / IDX
    'showingtime','mls','zillow','realtor_com','idxbroker',
    -- Social
    'facebook','instagram','linkedin','buffer',
    -- Media
    'heygen','google_flow','did',
    -- SMS providers (M.3 — Twilio/Telnyx/Bandwidth)
    'twilio','telnyx','bandwidth','sinch',
    -- Voice providers
    'vapi','plivo',
    -- Email providers
    'sendgrid','resend','postmark','mailgun',
    -- Calendar
    'google_calendar','outlook',
    -- Payments
    'stripe','plaid',
    -- Direct mail
    'lob'
  ]));

COMMIT;
