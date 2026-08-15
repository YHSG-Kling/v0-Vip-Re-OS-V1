-- m144 — extend marketing_agent_actions action_type vocabulary.
--
-- Wave 35. Two new resolution types the marketing agent can emit:
--
--   cancel_blog_cadence_tick(scope_type, scope_id)
--     Skip this week's auto-blog spawn for the given scope. Used when
--     the agent's snapshot shows blog cadence is overloaded (e.g.
--     blogChannel.publishedLast28d > target, or competing channels
--     deserve the week's attention). Records a one-week skip without
--     mutating the underlying cadence policy — the next tick fires
--     normally.
--
--   flag_listing_for_review(listing_id, reason)
--     Route a degraded asset to the broker's automation_errors review
--     queue instead of silently retrying. Used when the agent sees a
--     listing with chronically failed persona variants, repeat compliance
--     fails, or other patterns the human should look at directly.
--
-- Both gated server-side through the same approval flow Wave 34b built.

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
    'flag_listing_for_review'
  ));

-- cancel_blog_cadence_tick writes a date here; the cron checks
-- (skipped_until IS NULL OR skipped_until < today) before firing the
-- next tick for that scope. The skip is one-shot — the next week's
-- tick fires normally without policy mutation.
alter table public.blog_cadence_policy
  add column if not exists skipped_until date;
