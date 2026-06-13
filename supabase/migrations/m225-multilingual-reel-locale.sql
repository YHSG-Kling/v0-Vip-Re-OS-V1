-- m225 — Multilingual reel locale support.
--
-- Adds an optional `locale` column to ai_video_projects so multilingual reel
-- variants (commissioned by lib/video/multilingual-reel.ts commissionMultilingualReel)
-- can be identified by locale (BCP-47 tag, e.g. 'es', 'pt-BR', 'zh') without
-- touching the existing rows or schema invariants.
--
-- Design decisions:
--   · Column is NULLABLE (TEXT, no CHECK constraint — new locale tags can appear
--     without migrations; NULL means the original English / default-locale version).
--   · The idempotency key in video_metadata.director_key already namespaces by
--     entity+kind; the locale is appended as a suffix so same entity+kind+locale
--     never double-commissions.
--   · An index on (brokerage_id, locale) lets the content studio efficiently filter
--     variants for a given locale.

ALTER TABLE ai_video_projects
  ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT NULL;

COMMENT ON COLUMN ai_video_projects.locale IS
  'BCP-47 locale tag for multilingual reel variants (e.g. ''es'', ''pt-BR'', ''zh''). '
  'NULL = original / default-locale (usually English). Set by commissionMultilingualReel.';

CREATE INDEX IF NOT EXISTS idx_ai_video_projects_brokerage_locale
  ON ai_video_projects (brokerage_id, locale)
  WHERE locale IS NOT NULL;
