-- m232 — opt a campaign sequence STEP into persona+enrichment copy generation.
-- When ai_intent is set, renderSequenceStep generates the copy from THIS person's persona + their
-- Fair-Housing-safe enriched facts (using ai_intent as the goal) instead of token-interpolating a
-- static template body. Null = unchanged (template behaviour). This upgrades the WHOLE sequencer
-- from mail-merge to genuinely one-to-one copy, opt-in per step.
ALTER TABLE public.campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS ai_intent text;
