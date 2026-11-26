-- m301-revert-undecided-credential-vendors.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- REVERTING m297: THREE VENDORS THE BUSINESS NEVER DECIDED TO OWN.
--
-- m297 added 'xero', 'google' (Google Ads) and 'wordpress' to
-- platform_credentials.platform on the strength of finding OAuth config blocks
-- and a finished publisher in the code. That was the wrong evidence. This
-- repository decides vendor relationships in TWO places, and I consulted
-- neither:
--
--   lib/connections/scope.ts        CONNECTOR_PROVIDERS — the Connection OS
--                                   distinguished list; the settings UI,
--                                   write-side gating and every dispatch
--                                   resolver read it "so the allow-lists never
--                                   drift apart again".
--   lib/providers/tenancy-matrix.ts PROVIDER_TENANCY — "who owns each vendor
--                                   relationship, decided ONCE so it's never
--                                   re-litigated per feature".
--
-- xero, google/google_ads and wordpress appear in NEITHER. financial is
-- (quickbooks, stripe) — Xero is not offered. There is no ads domain and no
-- blog/CMS domain in the Connection OS at all.
--
-- An OAuth block in a route is not a product decision. Widening the column made
-- the database accept credentials the connection gating can never produce, and
-- put three undecided vendors into the schema as though they were supported.
-- Removed.
--
-- KEPT — 'platform_quickbooks' and 'platform_zoom'. Both underlying vendors ARE
-- decided (quickbooks in the tenancy matrix; zoom in CONNECTOR_PROVIDERS.meetings),
-- and the distinct-key form is the m273 idiom that lib/connections/accounting-scopes.ts
-- and lib/connections/zoom.ts implement deliberately: the tenant cascade falls
-- back to owner_type='platform', so reusing the plain keys would let a tenant
-- with no connection resolve the COMPANY's books or host on the COMPANY's Zoom.
-- Those two keys are the platform-owned half of an already-decided vendor, not a
-- new vendor.
--
-- SAFE: no row carries the removed values (verified before applying).
--
-- WHAT IS NOW HONESTLY BROKEN, and is the OWNER'S CALL — not mine to legislate:
--   · app/api/integrations/oauth/[provider]/route.ts declares xero + google_ads
--     providers that can complete a round trip and then cannot store.
--   · app/actions/blog.ts publishToWordPress is complete and can never be
--     configured.
-- Each is either a vendor to ADD properly (Connection OS domain + provider +
-- tenancy-matrix row + gating) or dead code to remove. Both are decisions, and
-- decisions are recorded in those two files first — not inferred from a route.

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
      'platform_quickbooks',     -- m297, KEPT — platform-owned half of quickbooks (m273 idiom)
      'platform_zoom'            -- m297, KEPT — platform-owned half of zoom (m273 idiom)
    ])
  );
