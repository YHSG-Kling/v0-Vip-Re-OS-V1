-- m281 — The WhatsApp webhook + DM reply lane map tenants via
-- social_media_accounts rows with platform='whatsapp', but the platform CHECK
-- never admitted the value — no WhatsApp Business account could ever be
-- connected (the CHECK-vocabulary silent-drift class). Widen the vocabulary.
--
-- Applied to the live database 2026-07-26 (MCP migration
-- social_media_accounts_platform_allow_whatsapp); this file mirrors it into
-- the repo record.
ALTER TABLE social_media_accounts DROP CONSTRAINT IF EXISTS social_media_accounts_platform_check;
ALTER TABLE social_media_accounts ADD CONSTRAINT social_media_accounts_platform_check
  CHECK (platform = ANY (ARRAY[
    'facebook'::text, 'instagram'::text, 'linkedin'::text, 'twitter'::text,
    'tiktok'::text, 'youtube'::text, 'pinterest'::text, 'google_business'::text,
    'whatsapp'::text
  ]));
