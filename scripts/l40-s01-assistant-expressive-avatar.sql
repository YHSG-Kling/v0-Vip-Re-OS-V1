-- l40-s01 — the assistant becomes a MOVING presenter (applied live 2026-07-09).
-- ai_identity_profiles.did_expressive_avatar_id: a D-ID V4 expressive avatar
-- id (format "...@avt_..."). When set, internal report videos (weekly show,
-- board packet) are hosted by the assistant AS A SENTIMENT-ALIGNED TALKING
-- AVATAR via /expressives instead of a still photo PIP. Photo (avatar_url)
-- remains the fallback; the agents' own Twin Studio avatars are untouched.
ALTER TABLE ai_identity_profiles ADD COLUMN IF NOT EXISTS did_expressive_avatar_id text;
