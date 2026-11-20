-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
-- default not dotloop"). Lane 88C.
--
-- READ LIVE FIRST (project hrvaqgvukzxfskkcrwbt, 2026-09-28):
--   offers_esign_provider_check =
--     CHECK (esign_provider = ANY (ARRAY['dotloop','docusign','skyslope','authentisign','in_app']))
--   contract_signatures.provider_name, listing_agreements.provider_name,
--   listings.external_provider_source, provider_overrides.provider_key — NO CHECK (nothing to widen).
--
-- The FormWizard's send (app/actions/buyer-offer/submit-for-signature.ts → the dispatch core
-- lib/esign/dispatch-packet.ts) stamps offers.esign_provider with the method that actually
-- carried the packet. For the default method that value is 'google_esign' — the same spelling the
-- provider cascade uses (provider_overrides.provider_key = 'google_esign', lib/kernel/providers.ts
-- SYSTEM_DEFAULTS.esign = DEFAULT_ESIGN_PROVIDER = 'google_esign', lane 88B's catalog entry; one vocabulary per function, CLAUDE.md §6). Without this
-- widening every Google-eSignature offer send is refused at the offer update (23514) AFTER
-- the packet is already in the agent's Drive.
--
-- WRITTEN, lane-owned; the integrator applies it and then regenerates the vocabulary cache
-- (scripts/check-vocabularies.ts) per CLAUDE.md §3.

begin;

alter table public.offers drop constraint if exists offers_esign_provider_check;
alter table public.offers add constraint offers_esign_provider_check
  check (esign_provider = any (array['dotloop','docusign','skyslope','authentisign','in_app','google_esign']::text[]));

commit;
