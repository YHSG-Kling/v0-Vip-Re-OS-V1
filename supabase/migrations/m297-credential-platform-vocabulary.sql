-- m297-credential-platform-vocabulary.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- FIVE FINISHED INTEGRATIONS THAT COULD NOT STORE A CREDENTIAL.
--
-- platform_credentials.platform admitted 53 values. Five complete, working
-- consumer paths named a value that was not among them, so each one ran end to
-- end and then failed on the very last write — the credential row itself.
--
-- 1. 'google' — GOOGLE ADS. app/api/integrations/oauth/[provider]/route.ts
--    carries a full google_ads provider: real authorize + token URLs, the
--    adwords scope, and the developer token folded into config. Its own comment
--    says the credential is "Stored under platform='google'" because that is
--    "what the ad connector loads". The OAuth round-trip completed, the token
--    was exchanged — and the insert was rejected. Google Ads could never be
--    connected.
--
-- 2. 'xero' — ACCOUNTING. The same route carries a full xero provider
--    (login.xero.com authorize, identity.xero.com token) whose stored platform
--    falls through to 'xero'. app/actions/accounting-sync.ts reads
--    platform='xero' for the connected state. Same shape: complete flow,
--    rejected at the last step.
--
-- 3. 'wordpress' — BLOG PUBLISHING. publishToWordPress is finished: it reads
--    api_url + api_key/access_token, builds the auth header, and POSTs to
--    /wp-json/wp/v2/posts. blog_posts.publish_target already admits 'wordpress'
--    and the blog editor renders a WordPress publish button. The credential it
--    needs is exactly what the generic "Add Platform Credential" form collects —
--    the only thing that ever stopped it was this CHECK, so the publisher
--    returned "WordPress credentials not configured" forever and no broker could
--    ever configure them.
--
-- 4+5. 'platform_quickbooks' / 'platform_zoom' — THE m273 IDIOM, WHICH IS A
--    SECURITY DESIGN. The platform's OWN QuickBooks and OWN Zoom are stored
--    under DISTINCT keys, on purpose: the tenant credential cascade falls back
--    to owner_type='platform', so reusing the plain 'quickbooks' / 'zoom' keys
--    would let a brokerage with no connection of its own resolve — and bill
--    against, or host meetings on — the COMPANY's account. The codebase calls
--    this "a leak impossible by construction" and spends two modules
--    (lib/connections/accounting-scopes.ts, lib/connections/zoom.ts) plus a
--    superadmin surface enforcing it.
--
--    Neither key was admitted. The superadmin page offers both connections, the
--    OAuth round-trip completes, and the insert is rejected — so the platform
--    could never connect its own books or its own Zoom. The failure was at
--    least SAFE (nothing leaked), but the feature was dead, and the obvious
--    "fix" for someone who did not read those headers would be to drop the
--    distinct key and reintroduce exactly the leak it exists to prevent.
--
-- NOT ADDED — 'tiktok'. ad_campaigns.platform admits 'tiktok' and the ads
-- workspace read a tiktok credential, but there is NO TikTok connector: no OAuth
-- provider, no connect form, nothing that could ever write that row. Adding the
-- value would create a vocabulary entry nothing can produce — the same dead
-- literal this sweep has been removing everywhere else. The ads code is changed
-- instead, to distinguish "not connected" from "not connectable".
--
-- Additive: nothing previously accepted is now rejected.

ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;

ALTER TABLE public.platform_credentials
  ADD CONSTRAINT platform_credentials_platform_check CHECK (
    platform = ANY (ARRAY[
      'dotloop', 'docusign', 'skyslope', 'authentisign', 'formsimplicity', 'brokermint',
      'showingtime', 'mls', 'zillow', 'realtor_com', 'idxbroker', 'listhub', 'mls_direct',
      'opcity', 'facebook', 'instagram', 'linkedin', 'buffer',
      'platform_social_facebook', 'platform_social_instagram', 'platform_social_linkedin',
      'platform_social_x', 'platform_social_tiktok', 'platform_social_youtube',
      'heygen', 'google_flow', 'did', 'pexels',
      'twilio', 'telnyx', 'bandwidth', 'sinch', 'vapi', 'plivo',
      'twilio_subaccount', 'twilio_byo', 'twilio_a2p',
      'sendgrid', 'resend', 'postmark', 'mailgun', 'gmail', 'outlook',
      'google_calendar', 'zoom', 'stripe', 'plaid', 'lob', 'quickbooks',
      'gohighlevel', 'followupboss', 'lofty', 'hubspot',
      'google',                  -- m297 — Google Ads (google_ads OAuth stores this)
      'xero',                    -- m297 — Xero accounting (xero OAuth stores this)
      'wordpress',               -- m297 — blog publishing (api_url + api_key)
      'platform_quickbooks',     -- m297 — platform-owned books (m273 idiom)
      'platform_zoom'            -- m297 — platform-owned Zoom (m273 idiom)
    ])
  );
