-- m149 — marketing-agent omnipresence_topic_fanout resolution action.
--
-- Wave 36 self-learning capstone. The marketing agent's snapshot
-- already surfaces per-(topic, persona) performance scores from
-- content_asset_persona_performance (m136). What's been missing is
-- the *action* the agent can emit when it spots a topic that's
-- crushing in one channel and deserves to be promoted across
-- newsletter + blog + social + direct mail in the same cycle.
--
--   omnipresence_topic_fanout(topic_id, channels[])
--     channels ⊂ {'newsletter','blog','social','direct_mail_postcard'}
--     The handler enqueues the topic for each named channel:
--       newsletter  → stageNewsletterDraft with topic title
--       blog        → blog generator with pullFromTopicBank=true bias
--       social      → social_posts row queued status='draft'
--       direct_mail_postcard → farm_mail dispatch with topicHook
--     Same compliance + cooldown + tenant gates as the per-channel
--     paths — fanout doesn't bypass anything. Just queues 4 actions
--     in 1 approval click rather than the agent emitting 4 separate
--     resolutions.
--
-- This action_type is what unlocks the "omnipresence" thesis: when a
-- topic is hot, the brokerage owns the conversation across every
-- channel the recipient touches that week.

alter table public.marketing_agent_actions
  drop constraint if exists marketing_agent_actions_action_type_check;
alter table public.marketing_agent_actions
  add constraint marketing_agent_actions_action_type_check
  check (action_type in (
    'retry_listing_promo_render',
    'mark_topic_used',
    'defer_newsletter_campaign',
    'stage_newsletter_draft',
    'cancel_blog_cadence_tick',
    'flag_listing_for_review',
    'verify_lead_address',
    'cancel_direct_mail_send',
    'retry_direct_mail_design',
    'flag_design_for_review',
    'omnipresence_topic_fanout'
  ));
