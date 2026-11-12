-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m705 — lifecycle MILESTONE badges (wave 103, lane 103C — layer 6, lifecycle gamification).
--
-- WHY. gamification_badges.trigger_event has existed since the catalog did, and m484 seeded only
-- 'points_threshold' rows because "a badge whose trigger_event named an event nothing emits would
-- be exactly the inert catalog this migration is fixing". The event reactor now awards lifecycle
-- milestones (lib/gamification/award-points.ts: LIFECYCLE_AWARD_RULES → awardLifecycleMilestones →
-- awardEventBadges), keyed on trigger_event = the POINT_VALUES reason it just credited. These rows
-- are the catalog that awarder reads. Each names a reason the code awards TODAY — none is inert.
--
-- IDEMPOTENT at the agent: agent_badges_unique(agent_id, badge_id) already exists (m484 §"does not
-- add a UNIQUE … already exists") and is what makes a milestone badge land once per agent for life.
-- IDEMPOTENT here: the m484 partial unique index gamification_badges_platform_name_key (badge_name
-- where brokerage_id is null) makes the seed re-runnable; `on conflict do nothing` rides it.
--
-- trigger_event is free text (no CHECK — scripts/check-vocabularies.ts carries none for this
-- column), so no CHECK is widened and the vocabulary cache needs no regeneration. required_points
-- is 0: the reactor awards these on the EVENT, and checkAndAwardBadges (the threshold awarder)
-- filters to trigger_event = 'points_threshold', so the two awarders never overlap on a row.
--
-- PART 1 (data only; no index, no trigger) — apply in one statement.
insert into public.gamification_badges
  (brokerage_id, badge_name, badge_description, badge_icon, badge_tier, badge_category,
   required_points, trigger_event, is_active)
values
  (null, 'Certified',            'Earned an onboarding certification.',                          'graduation-cap', 'bronze', 'milestone', 0, 'CERTIFICATION_EARNED',     true),
  (null, 'First Contact',        'Your first contact on the books.',                             'user-plus',      'bronze', 'milestone', 0, 'FIRST_CONTACT',            true),
  (null, 'First Appointment',    'Your first appointment set.',                                  'calendar-check', 'bronze', 'milestone', 0, 'FIRST_APPOINTMENT',        true),
  (null, 'First Close',          'Your first closed transaction.',                               'key',            'silver', 'milestone', 0, 'FIRST_CLOSE',              true),
  (null, 'Repeat Client',        'A past client came back to close with you again.',             'repeat',         'gold',   'milestone', 0, 'REPEAT_CLIENT_CLOSED',     true),
  (null, 'Referral Closed',      'A referral you received converted.',                           'handshake',      'silver', 'milestone', 0, 'REFERRAL_CONVERTED',       true),
  (null, 'Mentor',               'Held a mentor session.',                                       'users',          'bronze', 'milestone', 0, 'MENTOR_SESSION_HELD',      true),
  (null, 'Anniversary',          'A work anniversary with the brokerage.',                       'cake',           'bronze', 'milestone', 0, 'WORK_ANNIVERSARY',         true),
  (null, 'Client for Life',      'Kept an anniversary touch with a past client.',                'heart',          'bronze', 'milestone', 0, 'LIFETIME_TOUCHPOINT_KEPT', true)
on conflict do nothing;

-- POSTCONDITION — stated, then checked: every seeded trigger_event is a reason the code awards.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.gamification_badges
   where brokerage_id is null and required_points = 0
     and trigger_event in ('CERTIFICATION_EARNED','FIRST_CONTACT','FIRST_APPOINTMENT','FIRST_CLOSE',
                           'REPEAT_CLIENT_CLOSED','REFERRAL_CONVERTED','MENTOR_SESSION_HELD',
                           'WORK_ANNIVERSARY','LIFETIME_TOUCHPOINT_KEPT');
  if v_n < 9 then
    raise exception 'm705: expected 9 platform milestone badges, found %', v_n;
  end if;
end $$;

-- PART 2: none. No index, no trigger, no CHECK — the catalog rows are the whole change.
