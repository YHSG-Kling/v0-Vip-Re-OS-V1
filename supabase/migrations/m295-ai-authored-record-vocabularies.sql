-- m295-ai-authored-record-vocabularies.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- WHEN THE AI ACTS, ITS RECORD MUST BE STORABLE.
--
-- Three columns rejected the values the product's own autonomous surfaces write.
-- Each write is best-effort, so each was lost in silence.
--
-- 1. ai_assistant_notes.note_type — the AI review automation persists three
--    artifacts (a drafted review request, a recovery plan, a monitoring config)
--    and the column admitted none of them. Every insert was rejected, so the
--    review automation persisted NOTHING. The vocabulary is already
--    subsystem-specific (it carries loan_update and vendor_update), so naming
--    these three is consistent with how the column is already used — and it
--    keeps the distinction a future reviews surface will need to filter on,
--    rather than flattening all three to 'general'.
--
-- 2. content_topic_uses.asset_type — the topic-reuse ledger, which exists so the
--    same topic is not spent twice on the same channel. Direct-mail postcards
--    (marketing-agent + farm-mail) and situational reels (manager-signals) both
--    record a use and both were rejected, so those two channels were invisible
--    to de-duplication and could re-spend a topic indefinitely.
--
-- 3. showings.sync_source — names where a showing record originated. It admitted
--    only manual / other / showingtime, so a showing booked by the AI scheduler
--    or by a workflow sequence could not say so. Preserving the origin is the
--    point: 'other' would erase exactly the fact that an agent did not book it.
--
-- NOT WIDENED — ai_assistant_notes.source. That column names the PRODUCER CLASS
-- (ai_assistant | ai_draft_human_approved | human), not the subsystem. The code
-- wrote 'ai_review_automation' and 'internal_ai_assistant', which are both "an AI
-- produced it" — a category error, not a missing value. Those call sites are
-- repointed to 'ai_assistant' instead, and the subsystem detail now lives in
-- note_type where it belongs.
--
-- All three changes are additive: nothing previously accepted is now rejected.

ALTER TABLE public.ai_assistant_notes
  DROP CONSTRAINT IF EXISTS ai_assistant_notes_note_type_check;

ALTER TABLE public.ai_assistant_notes
  ADD CONSTRAINT ai_assistant_notes_note_type_check CHECK (
    note_type = ANY (ARRAY[
      'action_item', 'call_outcome', 'decision', 'follow_up', 'general',
      'loan_update', 'meeting_outcome', 'observation', 'vendor_update',
      'review_request_draft',      -- m295
      'review_recovery_plan',      -- m295
      'review_monitoring_config'   -- m295
    ])
  );

ALTER TABLE public.content_topic_uses
  DROP CONSTRAINT IF EXISTS content_topic_uses_asset_type_check;

ALTER TABLE public.content_topic_uses
  ADD CONSTRAINT content_topic_uses_asset_type_check CHECK (
    asset_type = ANY (ARRAY[
      'blog_post', 'marketing_plan_item', 'newsletter_campaign', 'newsletter_video',
      'podcast_episode', 'social_post',
      'direct_mail_postcard',      -- m295
      'situational_reel'           -- m295
    ])
  );

ALTER TABLE public.showings
  DROP CONSTRAINT IF EXISTS showings_sync_source_check;

ALTER TABLE public.showings
  ADD CONSTRAINT showings_sync_source_check CHECK (
    sync_source = ANY (ARRAY[
      'manual', 'other', 'showingtime',
      'ai_scheduler',              -- m295
      'workflow_sequence'          -- m295
    ])
  );
