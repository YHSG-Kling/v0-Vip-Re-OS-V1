-- Migration 1024: per-agent voice preferences for the on-the-go AI assistant
-- and the objection-training prospect.
--
-- These are user choices, not platform defaults. The platform supplies a
-- fallback only if the agent hasn't picked their own voice.
--
-- agents.voice_id            (existing) — the agent's CLONED voice. Used for
--                              outbound channels (avatars, ISA calls).
-- agents.assistant_voice_id  (NEW)      — the voice their personal AI
--                              assistant speaks back in. Defaults to their
--                              cloned voice so the assistant sounds like
--                              them; the agent can pick any ElevenLabs voice
--                              for a different co-pilot persona.
-- agents.prospect_voice_id   (NEW)      — the voice the AI uses when role-
--                              playing a prospect during objection training.
--                              Must be different from the agent's own voice
--                              so the practice feels like a real call.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS assistant_voice_id text,
  ADD COLUMN IF NOT EXISTS prospect_voice_id  text;
