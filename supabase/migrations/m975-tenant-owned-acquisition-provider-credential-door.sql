-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151F ──
--
-- m975 — A TENANT'S OWN BATCHDATA ACCOUNT HAS A CREDENTIAL DOOR (wave 151, lane 151F; directive 151F route B "Tenant-connected
-- account … through the EXISTING credential vault, provider registry/route table, capability adapter and monitoring").
--
-- WHAT THE CODE NOW WRITES (and the live CHECK, read back 2026-11-09 from hrvaqgvukzxfskkcrwbt, refuses):
--   · platform_credentials.platform 'batchdata' — app/actions/tenant-connections.ts connectTenantAcquisitionProviderAction stores
--     a TENANT's own BatchData token (encrypted, enc:v1) under owner_type 'brokerage' / owner_id = the brokerage, with the
--     tenant's agreement (scopes, retention, AI processing, redistribution prohibited, cost payer tenant), territory, frequency,
--     rate limit and OUR push signing secret in config (lib/providers/tenant-provider-connections.ts
--     buildTenantProviderCredentialRow). Readers: lib/connections/resolve-scoped.ts (the ownership cascade), the smart-search
--     webhook's tenant door (app/api/webhooks/batchdata-smart-search?connection=<id>), the lead-sources settings page.
--     Live CHECK: the 58 values below (m881 + nothing since) — 'batchdata' is not among them, so the insert is refused 23514
--     and the only tenant-connectable acquisition provider has no door.
--
-- ONLY 'batchdata' is admitted. PropertyRadar, Tracerfy and DataZapp stay dormant pending rights (owner ruling R9): no transport
-- exists in this repo, so a stored tenant credential would be a key nothing can use — the connection state says `unsupported`
-- honestly and no form offers a field (an adapter file is not a working integration). Admitting them is part of each one's
-- reviewed activation change, never this migration.
--
-- Every live value is KEPT exactly as read (no value dropped). Live rows before (2026-11-09): platform_credentials 0 rows with
-- platform 'batchdata' (the value is refused today) — nothing to backfill or rename. The platform's OWN BatchData account stays
-- env-held (BATCHDATA_API_KEY, route A) and is never a platform_credentials row.
--
-- Verification after applying:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'platform_credentials_platform_check';
--   → lists every value below; then regenerate scripts/check-vocabularies.ts (CLAUDE.md §3).
-- Rollback (only while no row carries 'batchdata'): re-run the block without the wave-151 value.

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
    'vibe','openai_ads','google_ads','groundtruth','stackadapt',
    -- wave 151, lane 151F (this migration): a tenant's OWN BatchData account (route B)
    'batchdata']));

COMMENT ON CONSTRAINT platform_credentials_platform_check ON public.platform_credentials IS
  'The canonical provider ids a credential row may name. Wave 151F adds batchdata (tenant-owned acquisition account; the platform account stays env-held).';
