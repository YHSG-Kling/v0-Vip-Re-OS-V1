-- Migration 1006: Self-listening voice/avatar preferences for agents
--
-- Outbound voice (agents.voice_id) and avatar (agents.avatar_id) are the
-- agent's CLONE — used for everything contacts experience (ISA calls,
-- portal AI chat, portal video chat). Some agents don't want to hear their
-- own voice when they ask their assistant a question or listen to the
-- morning brief. These columns let them pick a generic voice/avatar for
-- their own listening without breaking the contact-facing experience.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS assistant_voice_id TEXT,
  ADD COLUMN IF NOT EXISTS assistant_avatar_id TEXT,
  ADD COLUMN IF NOT EXISTS voice_preference TEXT DEFAULT 'clone'
    CHECK (voice_preference IN ('clone', 'generic'));

-- Resolution rules (see lib/voice/voice-resolver.ts):
--   voice_preference = 'clone'   → agent hears their own clone (assistant_voice_id ignored)
--   voice_preference = 'generic' → agent hears assistant_voice_id (or platform fallback if null)
--   Contact-facing surfaces ALWAYS use the agent's clone (voice_id) regardless of preference.
