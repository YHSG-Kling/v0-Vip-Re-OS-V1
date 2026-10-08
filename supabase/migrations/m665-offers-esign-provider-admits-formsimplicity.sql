-- ── APPLIED LIVE 2026-09-29 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
-- Lane 89A (wave 89). Owner: "if it is the transaction provider instead of the forms package
-- template in the platform, then the external provider's would open in the platform window, then
-- in within the provider, select the forms and fill it out … then save and send for esigning."
--
-- READ LIVE FIRST (project hrvaqgvukzxfskkcrwbt, 2026-09-29):
--   offers_esign_provider_check =
--     CHECK (esign_provider = ANY (ARRAY['dotloop','docusign','skyslope','authentisign','in_app','google_esign']))
--   provider_overrides.provider_key — NO CHECK; platform_credentials.platform — NO CHECK (owner_type only);
--   listings.external_provider_source — NO CHECK. Nothing else to widen.
--
-- The provider-window path (app/actions/buyer-offer/submit-for-signature.ts `providerWindow` →
-- lib/esign/dispatch-packet.ts describeProviderWindowSend) stamps offers.esign_provider with the
-- transaction provider whose window carried the forms. Form Simplicity (catalog: transactionForms +
-- esign via its Authentisign integration) is an implemented provider class whose name the CHECK
-- does not admit — a Form Simplicity provider-window send would be refused at the offer update
-- (23514) AFTER the agent already sent from that window. Brokermint has no e-sign and is refused
-- before any stamp, so it is not added.
--
-- After applying: regenerate scripts/check-vocabularies.ts (CLAUDE.md §3).

begin;

alter table public.offers drop constraint if exists offers_esign_provider_check;
alter table public.offers add constraint offers_esign_provider_check
  check (esign_provider = any (array['dotloop','docusign','skyslope','authentisign','in_app','google_esign','formsimplicity']::text[]));

commit;
