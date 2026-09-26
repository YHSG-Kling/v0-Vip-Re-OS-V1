-- m620-contacts-preferred-language.sql
-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-10 by the integrator (measured
-- first: contacts.preferred_language absent). The schema snapshot and the
-- check-vocabulary cache were regenerated from live JSON afterwards (§3), so
-- resolveContactLanguageFromDb's tier 1 is live.
--
-- Owner ruling, 2026-09-10 (wave 50): "the default language is english"; avatar
-- videos are one of the most important capabilities and need a real multilingual
-- resolver. The gap the wave-50 hardening pass found: the first-touch WELCOME
-- avatar video has no multilingual variant because contacts carry no
-- preferred_language and no transcript exists yet at first touch.
--
-- lib/video/multilingual-reel.ts::resolveContactLanguage is the ONE resolver
-- (§6 — one vocabulary per function) that answers "what language does this
-- contact's video/copy/captions render in", in this order:
--   1. contacts.preferred_language  (THIS column — the contact told us, or an
--      agent set it)
--   2. the most recent call_transcriptions.language for a call linked to this
--      contact via voice_calls.contact_id (they've spoken to us before, in a
--      language ElevenLabs/Whisper detected)
--   3. the intake-time locale (form locale field / Accept-Language header,
--      captured by lib/contact-pipeline/contact-capture.ts into
--      contacts.metadata->>'captured_language' at capture time — see that
--      file's "UNTIL THIS IS APPLIED" note, the same established pattern
--      m617's card_subject_type used while its typed columns were pending)
--   4. DEFAULT_LANGUAGE = "en" (owner ruling: "the default language is
--      english wherever a language is resolved and none is known")
--
-- UNTIL THIS IS APPLIED: resolveContactLanguageFromDb never SELECTs
-- preferred_language — it checks scripts/schema-snapshot.ts (SCHEMA_SNAPSHOT)
-- first and skips the column entirely when the live schema doesn't list it yet,
-- falling through to tiers 2-4. So shipping this code ahead of the migration is
-- safe: applying this migration later does not require a second code change,
-- it simply makes tier 1 start returning real values (the schema cache must be
-- regenerated first per CLAUDE.md §3 so the guard sees the new column).
--
-- The vocabulary below is EXACTLY the distinct output values of
-- lib/video/multilingual-reel.ts::LOCALE_TO_ELEVENLABS_LANGUAGE (its 23 target
-- codes) so the CHECK can never admit a code the resolver / TTS / caption path
-- doesn't already know how to route — one vocabulary (§6), not a second list
-- that could drift from the code's own map.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS preferred_language text
    CHECK (preferred_language IN (
      'en', 'es', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ar', 'hi', 'pl',
      'nl', 'ru', 'tr', 'uk', 'sv', 'no', 'da', 'fi', 'id', 'tl', 'vi'
    ));

COMMENT ON COLUMN contacts.preferred_language IS
  'ISO 639-1 language code the contact prefers for avatar videos, copy, and captions (owner ruling 2026-09-10, default "en" when null). Tier 1 of lib/video/multilingual-reel.ts::resolveContactLanguage — set by the contact themselves (portal preference) or an agent, distinct from the intake-time locale capture in contacts.metadata->>''captured_language'' (tier 3, a guess) and from call_transcriptions.language (tier 2, an observation). The vocabulary is exactly LOCALE_TO_ELEVENLABS_LANGUAGE''s 23 output codes in that file — extend both together.';
