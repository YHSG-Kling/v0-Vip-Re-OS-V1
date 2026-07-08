-- l33-s01-twilio-a2p-credential.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- A2P 10DLC AUTO-REGISTRATION — the per-tenant registration state machine
-- persists on platform_credentials (platform 'twilio_a2p': each TrustHub/
-- Messaging resource sid + step status in config jsonb). Widen the platform
-- CHECK to allow it. Idempotent.

ALTER TABLE public.platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE public.platform_credentials ADD CONSTRAINT platform_credentials_platform_check
CHECK ((platform = ANY (ARRAY['dotloop'::text, 'docusign'::text, 'skyslope'::text, 'authentisign'::text, 'formsimplicity'::text, 'brokermint'::text, 'showingtime'::text, 'mls'::text, 'zillow'::text, 'realtor_com'::text, 'idxbroker'::text, 'facebook'::text, 'instagram'::text, 'linkedin'::text, 'buffer'::text, 'heygen'::text, 'google_flow'::text, 'did'::text, 'twilio'::text, 'telnyx'::text, 'bandwidth'::text, 'sinch'::text, 'vapi'::text, 'plivo'::text, 'sendgrid'::text, 'resend'::text, 'postmark'::text, 'mailgun'::text, 'gmail'::text, 'outlook'::text, 'google_calendar'::text, 'stripe'::text, 'plaid'::text, 'lob'::text, 'quickbooks'::text, 'gohighlevel'::text, 'followupboss'::text, 'lofty'::text, 'hubspot'::text, 'twilio_subaccount'::text, 'twilio_byo'::text, 'pexels'::text, 'listhub'::text, 'mls_direct'::text, 'opcity'::text, 'twilio_a2p'::text])));
