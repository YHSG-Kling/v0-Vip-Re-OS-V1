-- Add D-ID photo quality tracking to agent voice profiles
ALTER TABLE agent_voice_profiles
  ADD COLUMN IF NOT EXISTS did_photo_quality_score INTEGER,
  ADD COLUMN IF NOT EXISTS did_photo_warnings TEXT[];
