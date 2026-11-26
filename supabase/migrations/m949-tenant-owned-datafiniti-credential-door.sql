-- ── APPLIED LIVE 2026-11-16 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153M ── read back pending in the same session: platform_credentials_platform_check = the 59 prior values + 'datafiniti'; 0 rows live
--
-- m949 — A TENANT'S OWN DATAFINITI ACCOUNT HAS A CREDENTIAL DOOR (wave 153, lane 153M; owner ruling B1 "Datainfinit needs to be
-- built"; directive Part B §3.2 "support both legitimate tenant-owned connection and selected platform-owned account through the
-- existing encrypted credential scopes; do not cross fallback between owners").
--
-- WHAT THE CODE NOW DECLARES (and the live CHECK, as the generated cache scripts/check-vocabularies.ts reads it, would refuse):
--   · lib/providers/tenant-provider-connections.ts TENANT_ACQUISITION_PROVIDERS.datafiniti — a transport-built provider
--     (lib/external/datafiniti-client.ts takes the tenant token by parameter, never the platform's) whose credential row is
--     platform_credentials.platform 'datafiniti' (owner_type 'brokerage', owner_id = the brokerage, api_key encrypted enc:v1 by
--     buildTenantProviderCredentialRow). The live CHECK lists the 59 values below without 'datafiniti', so the insert would be
--     refused 23514 the day the owner's licensing decision opens the door.
--
-- WHY IT IS SAFE TO APPLY BEFORE THE LICENSING DECISION: admitting a value stores nothing. While PROVIDER_ACTIVATION.datafiniti
-- is dormant_pending_rights the connection derives `pending_owner_licensing` (deriveTenantProviderConnectionState) and no form
-- offers a key field — this migration only removes the database refusal that would otherwise surface after the decision.
--
-- Every live value is KEPT exactly as the generated cache reads it (59 values; m975 + m881 lineage) — nothing dropped or renamed.
-- Live rows before: none can carry 'datafiniti' (the CHECK refuses it today) — nothing to backfill. The platform's OWN Datafiniti
-- account stays env-held (DATAFINITI_API_TOKEN, by name) and is never a platform_credentials row.
--
-- ORDERING NOTE: m949 is numbered below m975 (the lane's assigned number) but rewrites the SAME constraint AFTER it; its value list
-- is m975's list + 'datafiniti', so applying it after m975 loses nothing. Applying m975 again afterwards would drop 'datafiniti'.
--
-- Verification after applying:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'platform_credentials_platform_check';
--   → lists every value below; then regenerate scripts/check-vocabularies.ts (CLAUDE.md §3).
-- Rollback (only while no row carries 'datafiniti'): re-run m975's block.

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
    'batchdata',
    -- wave 153, lane 153M (this migration): a tenant's OWN Datafiniti People Data account
    'datafiniti']));

COMMENT ON CONSTRAINT platform_credentials_platform_check ON public.platform_credentials IS
  'The canonical provider ids a credential row may name. Wave 151F added batchdata; wave 153M adds datafiniti (tenant-owned people-data account; the platform account stays env-held; dormant pending rights until the owner''s licensing decision).';
