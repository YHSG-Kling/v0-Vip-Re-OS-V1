-- m585 — campaign_sequence_steps.channel admits 'remove_from_segment'.
--
-- APPLIED 2026-08-28 hrvaqgvukzxfskkcrwbt. The integrator compared the 24
-- restated values against the live CHECK before applying (only
-- remove_from_segment is added; nothing dropped), then regenerated the
-- vocabulary cache from a fresh live reading — which turned the two
-- transitional palette guards green (a new CHECK value has no green path until
-- its migration is applied, which is why the lane left them red on purpose).
--
-- contact_segments has carried removed_at since 062. The READERS honour it —
-- lib/marketing/email-campaign-sender.ts:148 resolves a segment-targeted
-- campaign's recipients with `.is("removed_at", null)`, and the contact detail
-- page filters the same way — and NOTHING IN THE TREE EVER WROTE IT. The only
-- writer of the table at all was the workflow 'add_to_segment' step. So a
-- contact who landed in a marketing segment received that segment's campaigns
-- forever: a live deliverability problem, not a cosmetic one-sided column.
--
-- The manual half of the fix needs no migration (an agent-facing removal on the
-- contact page, through app/actions/contacts/segment-membership.ts). THIS
-- migration is the automated half: a workflow step that can take someone off a
-- list, mirroring the one that puts them on. Without the widening,
-- campaign_sequence_steps_channel_check 23514-refuses every such step and the
-- builder's new palette entry saves nothing.
--
-- NOT A SPELLING OF 'remove_from_campaign', which already exists in this list.
-- That one writes sequence_enrollments (is this SEQUENCE still running for this
-- person; its body holds a sequence_id and its effect is "nothing after this
-- step runs"). This one writes contact_segments (which marketing LIST they are
-- on; its body holds a segment_id). Different tables, different readers, and a
-- contact can sit in a segment having never been enrolled in any sequence.
-- lib/workflow/adapters/segment-ops.ts carries the same comparison at the code.
--
-- The list below is the LIVE vocabulary as generated into
-- scripts/check-vocabularies.ts (24 values) plus the one new value. The CHECK
-- must be restated whole because Postgres has no "add a value to an IN list";
-- scripts/1026-workflow-os-sprint-a.sql, which last wrote this constraint, is
-- OLDER than the live set (it predates commission_video, send_for_esign and
-- send_gift) — restating from that file instead of from the live cache would
-- silently DROP three admitted channels and orphan every step already using
-- them.
--
-- AFTER APPLYING: regenerate the vocabulary cache (§3) —
--   scripts/generate-check-vocabularies.ts (its header carries the SQL)
-- so scripts/check-vocabulary-guard.ts, scripts/sequence-step-palette-guard.ts
-- and scripts/step-palette-consolidation-simulator.ts see the 25th value. Those
-- last two compare the palette against the CACHE and will report
-- 'remove_from_segment' as an offered-but-unsavable channel until they do.

alter table public.campaign_sequence_steps
  drop constraint if exists campaign_sequence_steps_channel_check;

alter table public.campaign_sequence_steps
  add constraint campaign_sequence_steps_channel_check check (channel in (
    'ad_campaign',
    'add_to_segment',
    'ai_call',
    'ai_image',
    'assign_task',
    'avm_cma',
    'commission_video',
    'condition',
    'direct_mail',
    'draft_document',
    'email',
    'in_app',
    'listing_landing_page',
    'newsletter',
    'remove_from_campaign',
    'remove_from_segment',   -- m585: the mirror of add_to_segment
    'schedule_showing',
    'schedule_tour',
    'send_for_esign',
    'send_gift',
    'sms',
    'social_post',
    'video',
    'voice_drop',
    'wait'
  ));

comment on constraint campaign_sequence_steps_channel_check on public.campaign_sequence_steps is
  'The dispatchable step vocabulary. Mirrors lib/workflow/step-palette.ts and lib/workflow/adapters/index.ts — palette == CHECK == registry, proved by scripts/step-palette-consolidation-simulator.ts. remove_from_segment (m585) closes a contact_segments membership; remove_from_campaign ends a sequence_enrollments run. Different tables, kept as separate steps deliberately.';

-- Membership hygiene for the new writer. `idx_cs_segment` (062) is
-- (segment_id, added_at DESC) and does not help the two predicates that now
-- matter: the sender resolving ACTIVE members of one segment, and the removal
-- matching one (brokerage, contact, segment) row. The unique constraint already
-- covers (contact_id, segment_id); this partial index is for the read side.
create index if not exists idx_cs_active_members
  on public.contact_segments (brokerage_id, segment_id)
  where removed_at is null;

comment on column public.contact_segments.removed_at is
  'When this membership was closed. NULL = an active member. Set by lib/marketing/segment-membership.ts removeContactFromSegment (the agent-facing door and the remove_from_segment workflow step); cleared by addContactToSegment on a re-add — the unique (contact_id, segment_id) constraint means one row per pair, so re-adding reuses the row rather than inserting a second. NOT a consent record: opt-out lives in contact_suppression_list / contacts.email_unsubscribed and is enforced at dispatch by lib/kernel/compliance/check-suppression.ts.';
