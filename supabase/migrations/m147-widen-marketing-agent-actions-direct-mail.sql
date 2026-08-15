-- m147 — extend marketing_agent_actions action_type vocabulary with the
-- direct-mail resolution surface from Wave 36.
--
-- Four new action types the marketing agent can emit when it observes
-- the direct-mail channel:
--
--   verify_lead_address(lead_id)
--     Re-run lib/external/lob-address-verify against a lead row whose
--     mailing_address_verified=false. Used when the agent's snapshot
--     shows a queued lead with a populated mailing_address but the
--     dispatch gate keeps blocking it. Updates the canonical flag in
--     place so downstream sends unlock.
--
--   cancel_direct_mail_send(campaign_id, reason)
--     Move a pending direct_mail_campaigns row to status='cancelled'
--     with a structured reason. Used when the agent detects a brand-
--     compliance issue (Fair Housing risk language, off-territory
--     send) or a duplicate dispatch is about to fire.
--
--   retry_direct_mail_design(campaign_id)
--     Re-dispatch a failed direct_mail_campaigns row through the egress
--     (dispatchDirectMail). The verification gate + de-conflict gate
--     still apply, so a real underlying problem will surface again.
--
--   flag_design_for_review(campaign_id, reason)
--     Route a degraded mailer design to the broker's automation_errors
--     review queue, parallel to flag_listing_for_review. The platform's
--     existing admin observability surfaces the entry — no new UI
--     needed.
--
-- All four pass through the same human-approved execution flow Wave 34b
-- built (executeAction() in lib/agents/marketing-agent-actions.ts).

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
    'flag_design_for_review'
  ));
