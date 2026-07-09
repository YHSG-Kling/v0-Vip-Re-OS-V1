-- l38-s01 — the HeyGen purge, finished at the schema (applied live 2026-07-09).
--
-- Owner rule: D-ID (photo/video avatars, created in the Studio) + ElevenLabs
-- (voice clones) ONLY. The functional paths were already D-ID-only, but the
-- legacy schema kept the old vendor alive in name:
--   · agent_voice_profiles.heygen_voice_clone_id — video-voice.ts was writing
--     ELEVENLABS voice ids into this heygen-named column (and reading clones
--     from it), splitting the voice-clone source of truth in two.
--   · video_branding_presets — HeyGen-era table (heygen_avatar_id /
--     heygen_template_id / heygen_voice_id columns), zero live readers.
-- Backfilled the canonical column, then dropped both. video-voice.ts now
-- reads/writes elevenlabs_voice_id exclusively.

UPDATE agent_voice_profiles
SET elevenlabs_voice_id = heygen_voice_clone_id
WHERE heygen_voice_clone_id IS NOT NULL AND elevenlabs_voice_id IS NULL;

ALTER TABLE agent_voice_profiles DROP COLUMN IF EXISTS heygen_voice_clone_id;
DROP TABLE IF EXISTS video_branding_presets;
