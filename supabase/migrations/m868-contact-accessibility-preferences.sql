-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145H ──
--
-- m868 — ACCESSIBILITY PREFERENCES ARE WHAT THE PERSON SAID, STORED ON THE CONTACT
--
-- Owner ruling 18 (2026-10-27): "Should be added as fields if important and necessary." Explicit, user-controllable
-- fields — communication format, captions / transcripts, language, text size / display, preferred portal modality —
-- with real readers AND writers, never inferred from age or demographics.
--
-- MEASURED BEFORE WRITING (read-only, 2026-10-27, scripts/schema-snapshot.ts + scripts/check-vocabularies.ts):
--   · contacts has NO accessibility column and no conversation-memory key for it (lane 144F Still open 5).
--   · contacts.preferred_language EXISTS (m620 CHECK, 23 ISO 639-1 codes = lib/video/language-vocabulary.ts). It is
--     the ONE language field and is NOT duplicated here: the accessibility writer writes it through that vocabulary.
--   · contacts.age_range / birthday exist and are DELIBERATELY not read by anything this migration serves.
--
-- SHAPE. One jsonb object, '{}' = nothing stated. Keys and values are the TS vocabulary in
-- lib/contacts/accessibility-preferences.ts (COMMUNICATION_FORMATS, TEXT_SIZES, PORTAL_MODALITIES, ACCESSIBILITY_FLAGS);
-- scripts/accessibility-preferences-guard.ts holds the arrays below equal to it. A key outside the list, or a value
-- outside its vocabulary, is refused (23514) — the writer refuses it first and says why.
--
-- WRITERS: app/actions/contacts/accessibility-preferences.ts (the contact in the portal; an agent / staff member at
-- the contact's request) → lib/contacts/accessibility-preferences.ts writeAccessibilityPreferences (provenance stamped).
-- READERS: readAccessibilityPreferences — education delivery (lib/agents/education-delivery-producer.ts,
-- lib/kernel/education.ts), the portal display (app/portal/[contactId]/layout.tsx), lane 145E's welcome composition.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (contacts + accessibility_preferences). The CHECK calls a
-- function, so scripts/check-vocabularies.ts (single-column IN-list CHECKs) does not list it; the guard reads this file.
-- ADD COLUMN with a constant DEFAULT is metadata-only on PostgreSQL 11+ (no table rewrite).

CREATE OR REPLACE FUNCTION public.contact_accessibility_preferences_valid(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p IS NOT NULL
     AND jsonb_typeof(p) = 'object'
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_object_keys(p) AS k(key)
            WHERE k.key <> ALL (ARRAY['communication_format','text_size','portal_modality','captions','transcript','high_contrast','reduce_motion']))
     AND (NOT (p ? 'communication_format') OR (p ->> 'communication_format') = ANY (ARRAY['text','video','audio']))
     AND (NOT (p ? 'text_size')            OR (p ->> 'text_size')            = ANY (ARRAY['standard','large','extra_large']))
     AND (NOT (p ? 'portal_modality')      OR (p ->> 'portal_modality')      = ANY (ARRAY['standard','screen_reader','audio']))
     AND (NOT (p ? 'captions')      OR jsonb_typeof(p -> 'captions')      = 'boolean')
     AND (NOT (p ? 'transcript')    OR jsonb_typeof(p -> 'transcript')    = 'boolean')
     AND (NOT (p ? 'high_contrast') OR jsonb_typeof(p -> 'high_contrast') = 'boolean')
     AND (NOT (p ? 'reduce_motion') OR jsonb_typeof(p -> 'reduce_motion') = 'boolean')
$$;

COMMENT ON FUNCTION public.contact_accessibility_preferences_valid(jsonb) IS
  'm868: the accessibility-preferences vocabulary (lib/contacts/accessibility-preferences.ts). Keys: communication_format text|video|audio, text_size standard|large|extra_large, portal_modality standard|screen_reader|audio, captions/transcript/high_contrast/reduce_motion boolean. Language is contacts.preferred_language, not a key here.';

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS accessibility_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_accessibility_preferences_valid
    CHECK (public.contact_accessibility_preferences_valid(accessibility_preferences));

COMMENT ON COLUMN public.contacts.accessibility_preferences IS
  'm868 (owner ruling 18): what the PERSON stated they need — written only by the contact in the portal or by staff at the contact''s request (provenance in enrichment_profile.field_provenance.accessibility_preferences); never inferred from age or demographics. {} = nothing stated → the one default. Read through lib/contacts/accessibility-preferences.ts readAccessibilityPreferences.';

-- VERIFY (read-only, after applying):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'accessibility_preferences';
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.contacts'::regclass AND conname = 'contacts_accessibility_preferences_valid';
--   SELECT public.contact_accessibility_preferences_valid('{"captions":true,"text_size":"large"}'::jsonb)   -- true
--        , public.contact_accessibility_preferences_valid('{"age_band":"65+"}'::jsonb)                     -- false (positive control)
--        , public.contact_accessibility_preferences_valid('{"text_size":"huge"}'::jsonb);                   -- false
