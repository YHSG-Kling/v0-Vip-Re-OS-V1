-- m190: cross-manager handoff actions. When a listing goes active or a deal closes,
-- the listing/deal manager PROPOSES the downstream coordinated campaign into the
-- Command Center (governed) instead of the marketing agent rediscovering it on a
-- weekly cron. Reuses the marketing_agent_actions ledger (one surface).
alter table public.marketing_agent_actions
  drop constraint if exists marketing_agent_actions_action_type_check;
alter table public.marketing_agent_actions
  add constraint marketing_agent_actions_action_type_check check (action_type = any (array[
    'retry_listing_promo_render','mark_topic_used','defer_newsletter_campaign',
    'stage_newsletter_draft','cancel_blog_cadence_tick','flag_listing_for_review',
    'verify_lead_address','cancel_direct_mail_send','retry_direct_mail_design',
    'flag_design_for_review','omnipresence_topic_fanout','start_prelisting_drip',
    'approve_prelisting_delivery','promote_new_listing','just_sold_campaign'
  ]));
