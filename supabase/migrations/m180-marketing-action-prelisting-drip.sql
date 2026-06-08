-- m180 — Wave 39: add 'start_prelisting_drip' to marketing_agent_actions.
-- Lets the marketing manager agent propose (and a human approve, via the
-- Command Center) the seller-facing pre-listing presentation drip on demand.
alter table public.marketing_agent_actions drop constraint marketing_agent_actions_action_type_check;
alter table public.marketing_agent_actions add constraint marketing_agent_actions_action_type_check
  check (action_type = any (array[
    'retry_listing_promo_render','mark_topic_used','defer_newsletter_campaign','stage_newsletter_draft',
    'cancel_blog_cadence_tick','flag_listing_for_review','verify_lead_address','cancel_direct_mail_send',
    'retry_direct_mail_design','flag_design_for_review','omnipresence_topic_fanout',
    'start_prelisting_drip']));
