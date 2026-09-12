-- m296-approval-rail-vocabularies.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE APPROVAL RAIL COULD NOT SAY "NO", AND TWO SOURCES COULD NOT GET ON IT.
--
-- 1. blog_posts.publish_status — REJECTION DID NOT STICK.
--    applyMarketingAssetRejection drops a rejected blog to
--    publish_status='rejected' with the stated intent, in its own comment, that
--    "the post leaves BOTH review queues and the publish cron can never ship
--    it". The column admitted no such value, so that update was rejected and
--    publish_status stayed 'draft' — which is BLOG_PENDING_PUBLISH_STATUS, the
--    exact value both approval queues treat as awaiting-a-human. A rejected blog
--    post therefore stayed in the queue AND stayed publishable. This is not a
--    spelling drift: 'rejected' is a real terminal state the ladder was missing,
--    and it is distinct from 'archived' (which means it WAS published and has
--    since been retired).
--
-- 2. property_alerts.source — AN ENTIRE FEATURE COULD NOT WRITE ITS FIRST ROW.
--    Buyer criteria stated on a call (lib/voice/call-analysis.ts) or written in
--    an inbound email/SMS (lib/buyer-search/written-criteria-alert.ts) are
--    extracted and proposed as ONE inactive property alert for the agent to
--    approve on the /approvals rail. Both writers set
--    source='voice_conversation' / 'text_conversation'; the column admitted
--    neither, so every proposal was rejected and the rail's matching filter had
--    nothing to find — the feature was dead at both ends simultaneously.
--
--    These are NOT collapsible into 'system_generated'. The approval rail pins
--    its approve/reject cascade to these two sources precisely so it can never
--    activate — or DELETE — a live or agent-created alert. Flattening them would
--    point a delete at real alerts. The distinction is a safety boundary, so it
--    is stored.
--
-- Both changes are additive: nothing previously accepted is now rejected.
--
-- NOT MIGRATED HERE — two sibling defects in this cluster are code-only and
-- need no schema change:
--   · video_snippets.approval_status: readers filtered 'pending' while the
--     writer already writes 'pending_review' (documented as drift in
--     video-repurposing.ts). That is a spelling drift, so the READERS are
--     repointed onto the shared approval-pending constant rather than the
--     vocabulary widened.
--   · property_alerts.paused_by: the IDX disconnect wrote 'admin_disconnect'
--     into a column whose vocabulary is ACTOR CLASS (agent | buyer | system).
--     An event name in an actor column is a category error, so the call site is
--     repointed to 'system' and the event moves to paused_reason.

ALTER TABLE public.blog_posts
  DROP CONSTRAINT IF EXISTS blog_posts_publish_status_check;

ALTER TABLE public.blog_posts
  ADD CONSTRAINT blog_posts_publish_status_check CHECK (
    publish_status = ANY (ARRAY[
      'draft', 'pending_review', 'approved', 'scheduled', 'published', 'archived',
      'rejected'                 -- m296
    ])
  );

ALTER TABLE public.property_alerts
  DROP CONSTRAINT IF EXISTS property_alerts_source_check;

ALTER TABLE public.property_alerts
  ADD CONSTRAINT property_alerts_source_check CHECK (
    source = ANY (ARRAY[
      'agent_created', 'buyer_adjusted', 'system_generated',
      'voice_conversation',      -- m296
      'text_conversation'        -- m296
    ])
  );
