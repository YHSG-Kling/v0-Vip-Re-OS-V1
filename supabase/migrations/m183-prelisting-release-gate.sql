-- m183: Pre-listing RELEASE gate (gate 2)
-- Gate 1 (produce/render) is automatic. The single human gate is RELEASE: once the
-- finished avatar video + announcement email exist, the marketing manager surfaces
-- the ACTUAL product into the Command Center for one review-and-release per
-- presentation. Nothing reaches the seller until delivery_approved_at is stamped.

alter table public.listing_presentations
  add column if not exists delivery_approved_at timestamptz,
  add column if not exists delivery_approved_by uuid references public.users(id);

comment on column public.listing_presentations.delivery_approved_at is
  'Gate 2: when a human reviewed the finished video+email and RELEASED it to the seller. NULL = held; the drip will not deliver until this is set.';

-- New governed action: review the finished pre-listing product and release it.
alter table public.marketing_agent_actions
  drop constraint if exists marketing_agent_actions_action_type_check;
alter table public.marketing_agent_actions
  add constraint marketing_agent_actions_action_type_check check (action_type = any (array[
    'retry_listing_promo_render','mark_topic_used','defer_newsletter_campaign',
    'stage_newsletter_draft','cancel_blog_cadence_tick','flag_listing_for_review',
    'verify_lead_address','cancel_direct_mail_send','retry_direct_mail_design',
    'flag_design_for_review','omnipresence_topic_fanout','start_prelisting_drip',
    'approve_prelisting_delivery'
  ]));

-- Index the held-but-rendered presentations the gate-2 sweep scans each tick.
create index if not exists idx_listing_presentations_awaiting_release
  on public.listing_presentations (brokerage_id)
  where delivery_approved_at is null;
