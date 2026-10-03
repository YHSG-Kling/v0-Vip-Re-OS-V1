-- m290-zoom-provider-platform.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING: "zoom is a setup'd provider platform and tenants."
--
-- lib/onboarding/critical-setup.ts has carried a `zoomConnected` readiness item
-- since it was written:
--
--     zoomConnected: boolean   // platform_credentials platform='zoom' (brokerage-owned)
--
-- but 'zoom' was never in the platform_credentials.platform CHECK. The setup
-- item could therefore never be satisfied: a brokerage that connected Zoom could
-- not have the credential stored (the insert is rejected), and the readiness
-- checker's filter matched nothing on every run. It was a permanently-red row on
-- the onboarding meter with no way to turn it green.
--
-- Zoom is tenant-scoped like every other connectable provider — owner_type
-- 'brokerage' (already admitted by platform_credentials_owner_type_check), so
-- only the platform vocabulary needs to widen.
--
-- Additive only: this widens the allowed set and rejects nothing that was
-- previously accepted, so it cannot invalidate an existing row.

ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;

ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check CHECK (
    platform = ANY (ARRAY[
      -- transaction / forms
      'dotloop', 'docusign', 'skyslope', 'authentisign', 'formsimplicity', 'brokermint',
      -- listings / MLS
      'showingtime', 'mls', 'zillow', 'realtor_com', 'idxbroker', 'listhub', 'mls_direct', 'opcity',
      -- social
      'facebook', 'instagram', 'linkedin', 'buffer',
      'platform_social_facebook', 'platform_social_instagram', 'platform_social_linkedin',
      'platform_social_x', 'platform_social_tiktok', 'platform_social_youtube',
      -- media / avatar
      'heygen', 'google_flow', 'did', 'pexels',
      -- voice / messaging
      'twilio', 'telnyx', 'bandwidth', 'sinch', 'vapi', 'plivo',
      'twilio_subaccount', 'twilio_byo', 'twilio_a2p',
      -- email
      'sendgrid', 'resend', 'postmark', 'mailgun', 'gmail', 'outlook',
      -- calendar + meetings
      'google_calendar',
      'zoom',                                   -- m290: the zoomConnected setup item
      -- money
      'stripe', 'plaid', 'lob', 'quickbooks',
      -- CRM
      'gohighlevel', 'followupboss', 'lofty', 'hubspot'
    ])
  );
