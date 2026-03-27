-- Add content_hash to ai_assistant_notes for duplicate-save prevention.
-- Stores a normalized hash of note_text used to detect double-saves within a short window.
ALTER TABLE ai_assistant_notes ADD COLUMN IF NOT EXISTS content_hash text;

CREATE INDEX IF NOT EXISTS idx_ai_assistant_notes_dedup
  ON ai_assistant_notes (created_by, content_hash, created_at)
  WHERE content_hash IS NOT NULL;
