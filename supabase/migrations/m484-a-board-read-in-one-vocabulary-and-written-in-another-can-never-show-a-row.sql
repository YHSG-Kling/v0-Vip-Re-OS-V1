-- m484 — A BOARD READ IN ONE VOCABULARY AND WRITTEN IN ANOTHER CAN NEVER SHOW A ROW
--
-- The owner asked that gamification be open so agents can see where they stand, with
-- awards for staying competitive. The openness already existed — /dashboard/motivation
-- has no role gate and the agent nav carries it. Everything BEHIND it was inert, and
-- this migration is the database half of making it real. Measured live on project
-- hrvaqgvukzxfskkcrwbt (2026-08-18) before authoring:
--
--   leaderboard_rankings   0 rows      agent_points_log     0 rows
--   gamification_badges    0 rows      agent_badges         0 rows
--   achievements           0 rows      agent_achievements   0 rows
--   agents                 5 rows, gamification_points = 0 for all five
--
-- Six things land here.
--
-- (A) POINT-FORGING IS CLOSED. agent_points_log's INSERT policy was, verbatim,
--     `TO authenticated WITH CHECK (true)`. Any signed-in user — including a
--     consumer portal seat — could write any number of points for any agent in any
--     tenant, and the leaderboard is built from exactly that table. On a competitive
--     board that is not a hardening opportunity, it is the board being unfalsifiable.
--     The policy is rebuilt with the m482/m483 idiom (tenant pin + is_tenant_staff_seat)
--     plus two tests this table specifically needs: the agent credited must belong to
--     the caller's own brokerage, and a non-admin seat may only credit ITSELF.
--
-- (B) brokerage_id BECOMES NOT NULL on agent_points_log. app/actions/agents.awardPoints
--     never supplied it, and the leaderboard populator filters on that exact column —
--     so every row that writer produced was invisible to the board it existed to feed.
--     A ledger row with no tenant is a row no board can ever count.
--
-- (C) ONE ATOMIC AWARD PATH — public.award_agent_points(). Six app writers advanced
--     points and no two agreed: four did read-modify-write on agents.gamification_points
--     (lost updates), two wrote the ledger and never the total, one wrote the total and
--     never the ledger, and app/actions/ai-agent-onboarding.ts SET the total to 100 —
--     an absolute overwrite that deleted whatever the agent had earned. The function
--     does the increment and the ledger row in one transaction, deriving the tenant
--     from the agents row so no caller can mis-stamp it. All six now route through it.
--
-- (D) ONE REWARD LEDGER. `achievements`/`agent_achievements` and
--     `gamification_badges`/`agent_badges` were the same idea twice — a catalog of
--     named rewards unlocked at a points threshold plus a per-agent award ledger.
--     The badges pair survives: it is tenant-scoped with platform defaults at
--     brokerage_id IS NULL, tiered against a live CHECK, and already read by Agent 360.
--     The achievements pair's one distinct idea (`category`) is merged onto it as
--     `badge_category`, its rows are migrated, and then it is dropped.
--
-- (E) THE BOARD'S OWN VOCABULARY IS NARROWED TO WHAT IS WRITEABLE. scope loses
--     'agent' — every row is already per-agent (agent_id NOT NULL), so 'agent' was the
--     row GRAIN restated as a filter, and three readers sent it against a writer that
--     never wrote it. metric_type loses 'revenue' — nothing has ever written it, and
--     this is a PEER-VISIBLE board: standing rulings #185 and #57 took commission off
--     agent-facing display, so what a colleague may see is what you DID, not what you
--     were paid. What remains is exactly what lib/recruiting/leaderboard.ts writes:
--     scope ∈ {brokerage, team}, metric ∈ {points, transactions, referrals}.
--
-- (F) THE BADGE CATALOG IS SEEDED as platform defaults so an award can actually
--     happen. Five rungs, each tied to the one event the system genuinely awards on
--     (a points threshold, checked by app/actions/gamification.ts:checkAndAwardBadges),
--     at the thresholds of the single tier ladder in lib/gamification/tiers.ts.
--     Tenants may add their own on top; `brokerage_id IS NULL` is already how the live
--     RLS policies express "everyone's".
--
-- NOT APPLIED BY THIS LANE. Written for review and applied by the parent.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. GLOBAL PRECONDITIONS. The helpers and the tables must already exist —
--    creating them here would be claiming ownership this migration does not have.
do $$
declare
  v_fn text;
  v_tbl text;
begin
  foreach v_fn in array array[
    'is_tenant_staff_seat','current_user_brokerage_id','current_user_agent_id',
    'is_brokerage_admin','is_platform_admin'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
    ) then
      raise exception 'm484: public.%() does not exist — the tenancy baseline is missing, refusing', v_fn;
    end if;
  end loop;

  foreach v_tbl in array array[
    'agents','agent_points_log','leaderboard_rankings','gamification_badges','agent_badges'
  ] loop
    if to_regclass('public.' || v_tbl) is null then
      raise exception 'm484: public.% does not exist — refusing', v_tbl;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. (B) agent_points_log.brokerage_id — backfill from the agent, then NOT NULL.
--    Measured 0 rows, so the backfill is a no-op today and a safety net if this
--    lands later than expected.
update public.agent_points_log l
   set brokerage_id = a.brokerage_id
  from public.agents a
 where l.agent_id = a.id
   and l.brokerage_id is null;

do $$
declare v_orphans int;
begin
  select count(*) into v_orphans from public.agent_points_log where brokerage_id is null;
  if v_orphans <> 0 then
    raise exception 'm484: % agent_points_log rows still have no brokerage after backfill (their agent row is missing) — refusing to add NOT NULL over them', v_orphans;
  end if;
end $$;

alter table public.agent_points_log alter column brokerage_id set not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. (A) agent_points_log INSERT — close the forging door.
--    Refuses loudly if the live policy is not the one that was measured, rather
--    than rewriting a rule that moved since the census.
do $$
declare
  r record;
  v_count int;
begin
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'agent_points_log' and cmd = 'INSERT';
  if v_count <> 1 then
    raise exception 'm484(agent_points_log): expected exactly 1 INSERT policy, found % — the ground shifted, refusing', v_count;
  end if;

  select policyname, with_check into r
  from pg_policies
  where schemaname = 'public' and tablename = 'agent_points_log' and cmd = 'INSERT';

  if r.policyname <> 'agent_points_log_insert' then
    raise exception 'm484(agent_points_log): the INSERT policy is named %, not agent_points_log_insert — refusing', r.policyname;
  end if;
  if btrim(coalesce(r.with_check, '')) <> 'true' then
    raise exception 'm484(agent_points_log): with_check reads % rather than the measured `true` — it has already been tightened by someone else, refusing', r.with_check;
  end if;

  drop policy "agent_points_log_insert" on public.agent_points_log;

  -- Four tests, each answering a different way the old policy could be abused:
  --   · the row's tenant is the caller's tenant             (no cross-tenant writes)
  --   · the caller holds a staff seat                       (no consumer-portal writes)
  --   · the credited agent lives in that same tenant        (no crediting a stranger)
  --   · a non-admin seat may only credit ITSELF             (no inflating a rival, no
  --                                                          draining one either)
  --
  -- THE agents SUBQUERY RUNS UNDER THE CALLER'S OWN RLS, so it depends on
  -- `agents_read_brokerage` continuing to admit staff seats reading their own
  -- brokerage's roster — measured live 2026-08-18: it admits agent / broker /
  -- broker_owner / admin / superadmin / tc / team_lead / compliance / isa / lender /
  -- vendor within current_user_brokerage_id(). Narrowing that policy to own-row-only
  -- would refuse legitimate awards here; the app path is unaffected either way,
  -- because it goes through award_agent_points(), which is SECURITY DEFINER.
  create policy "agent_points_log_insert" on public.agent_points_log
    for insert to authenticated
    with check (
      brokerage_id = public.current_user_brokerage_id()
      and public.is_tenant_staff_seat()
      and exists (
        select 1 from public.agents a
        where a.id = agent_points_log.agent_id
          and a.brokerage_id = public.current_user_brokerage_id()
      )
      and (
        public.is_brokerage_admin()
        or public.is_platform_admin()
        or agent_points_log.agent_id = public.current_user_agent_id()
      )
    );
  raise notice 'm484: agent_points_log INSERT is no longer WITH CHECK (true)';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. (C) THE ONE ATOMIC AWARD PATH.
--
--     SECURITY DEFINER is what lets an ordinary agent seat earn points at all: the
--     policy above deliberately refuses a direct INSERT that credits anyone but the
--     caller, and this function applies the same rule itself before writing. It runs
--     as its owner — measured live 2026-08-18, public.agents / agent_points_log are
--     both owned by `postgres` with relforcerowsecurity = false, so the owner is not
--     subject to their RLS. search_path is pinned; auth.uid() is schema-qualified.
create or replace function public.award_agent_points(
  p_agent_id uuid,
  p_points integer,
  p_reason text,
  p_reference_type text default null,
  p_reference_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_brokerage uuid;
  v_total integer;
  v_log_id uuid;
  v_caller uuid := auth.uid();
begin
  if p_agent_id is null then
    raise exception 'award_agent_points: no agent was named';
  end if;
  if p_points is null or p_points = 0 then
    raise exception 'award_agent_points: % is not an award', coalesce(p_points::text, 'null');
  end if;

  -- THE TENANT IS DERIVED, NEVER ACCEPTED. agent_id is an agents.id; the brokerage
  -- comes off that row, so a caller cannot stamp a ledger row into a tenant of
  -- their choosing.
  select brokerage_id into v_brokerage from public.agents where id = p_agent_id;
  if v_brokerage is null then
    raise exception 'award_agent_points: there is no agents row for % to award points to', p_agent_id;
  end if;

  -- A SESSIONLESS caller is the service role — the cron and kernel lanes, which
  -- bypass RLS everywhere by construction. A SESSION caller is held to the same
  -- rule the agent_points_log INSERT policy applies, restated here because
  -- SECURITY DEFINER bypasses that policy.
  if v_caller is not null then
    if not public.is_tenant_staff_seat() then
      raise exception 'award_agent_points: a staff seat is required to award points';
    end if;
    if public.current_user_brokerage_id() is distinct from v_brokerage then
      raise exception 'award_agent_points: that agent is not in your brokerage';
    end if;
    if not (public.is_brokerage_admin() or public.is_platform_admin())
       and p_agent_id is distinct from public.current_user_agent_id() then
      raise exception 'award_agent_points: you may only award points to your own record';
    end if;
  end if;

  -- ONE TRANSACTION, TWO WRITES. The increment is done BY THE DATABASE
  -- (gamification_points + p_points), not by reading the value into the app and
  -- writing it back, so concurrent awards cannot lose each other.
  update public.agents
     set gamification_points = coalesce(gamification_points, 0) + p_points,
         updated_at = now()
   where id = p_agent_id
  returning gamification_points into v_total;

  insert into public.agent_points_log (agent_id, brokerage_id, points, reason, reference_type, reference_id)
  values (p_agent_id, v_brokerage, p_points, p_reason, p_reference_type, p_reference_id)
  returning id into v_log_id;

  return jsonb_build_object(
    'agent_id', p_agent_id,
    'brokerage_id', v_brokerage,
    'points_added', p_points,
    'new_total', v_total,
    'log_id', v_log_id
  );
end $$;

revoke all on function public.award_agent_points(uuid, integer, text, text, uuid) from public;
grant execute on function public.award_agent_points(uuid, integer, text, text, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. (D) ONE REWARD LEDGER — merge, migrate, then drop the duplicate.

-- 4a. The one idea `achievements` had that the badge catalog did not.
alter table public.gamification_badges add column if not exists badge_category text;

-- 4b. A badge name is unique WITHIN its owner: once across the platform defaults,
--     once per brokerage. Without this the seed below could not be idempotent, and
--     a tenant could hold two badges with the same name and different thresholds.
create unique index if not exists gamification_badges_platform_name_key
  on public.gamification_badges (badge_name) where brokerage_id is null;
create unique index if not exists gamification_badges_tenant_name_key
  on public.gamification_badges (brokerage_id, badge_name) where brokerage_id is not null;

-- 4c. Migrate any achievement catalog rows onto the survivor as platform defaults —
--     `achievements` had no brokerage_id at all, so platform-default is the only
--     honest home for them. Measured 0 rows; written so it is correct regardless.
do $$
begin
  if to_regclass('public.achievements') is null then
    raise notice 'm484: public.achievements is already gone — nothing to merge';
    return;
  end if;

  insert into public.gamification_badges
    (brokerage_id, badge_name, badge_description, badge_icon, badge_tier,
     badge_category, required_points, trigger_event, is_active)
  select
    null::uuid,
    a.name,
    a.description,
    a.badge_url,
    -- The achievements table had no tier; place each on the ladder its threshold
    -- already puts it on (lib/gamification/tiers.ts).
    case
      when a.points_required >= 25000 then 'platinum'
      when a.points_required >= 10000 then 'gold'
      when a.points_required >= 2500  then 'silver'
      else 'bronze'
    end,
    a.category,
    a.points_required,
    'points_threshold',
    a.is_active
  from public.achievements a
  on conflict do nothing;

  if to_regclass('public.agent_achievements') is not null then
    insert into public.agent_badges (brokerage_id, agent_id, badge_id, awarded_at, awarded_reason)
    select ag.brokerage_id, aa.agent_id, gb.id, aa.unlocked_at, 'Migrated from achievements (m484)'
    from public.agent_achievements aa
    join public.achievements a on a.id = aa.achievement_id
    join public.gamification_badges gb on gb.badge_name = a.name and gb.brokerage_id is null
    join public.agents ag on ag.id = aa.agent_id
    on conflict do nothing;
  end if;
end $$;

-- 4d. The duplicate goes. agent_achievements FKs achievements ON DELETE CASCADE,
--     so it is dropped first and explicitly rather than by cascade.
drop table if exists public.agent_achievements;
drop table if exists public.achievements;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. (E) THE BOARD'S VOCABULARY = WHAT THE POPULATOR WRITES.
do $$
declare v_bad int;
begin
  select count(*) into v_bad from public.leaderboard_rankings where scope not in ('brokerage','team');
  if v_bad <> 0 then
    raise exception 'm484: % leaderboard_rankings rows carry a scope outside {brokerage,team} — re-snapshot before narrowing the CHECK, refusing', v_bad;
  end if;
  select count(*) into v_bad from public.leaderboard_rankings where metric_type not in ('points','transactions','referrals');
  if v_bad <> 0 then
    raise exception 'm484: % leaderboard_rankings rows carry a metric outside {points,transactions,referrals} — refusing', v_bad;
  end if;
end $$;

alter table public.leaderboard_rankings drop constraint if exists leaderboard_rankings_scope_check;
alter table public.leaderboard_rankings
  add constraint leaderboard_rankings_scope_check
  check (scope = any (array['brokerage'::text, 'team'::text]));

alter table public.leaderboard_rankings drop constraint if exists leaderboard_rankings_metric_type_check;
alter table public.leaderboard_rankings
  add constraint leaderboard_rankings_metric_type_check
  check (metric_type = any (array['points'::text, 'transactions'::text, 'referrals'::text]));

-- A team-scope row must name its team, and a brokerage-scope row must not — the
-- column existed since the table did and every row ever written left it NULL.
alter table public.leaderboard_rankings drop constraint if exists leaderboard_rankings_team_scope_check;
alter table public.leaderboard_rankings
  add constraint leaderboard_rankings_team_scope_check
  check ((scope = 'team' and team_id is not null) or (scope = 'brokerage' and team_id is null));

-- One agent holds one rank per board. The populator replaces a board by
-- delete-then-insert; this makes a double-write impossible rather than unlikely.
create unique index if not exists leaderboard_rankings_board_agent_key
  on public.leaderboard_rankings (
    brokerage_id, scope, (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    metric_type, period_label, agent_id
  );

-- The read path every board reader uses, in its filter order.
create index if not exists leaderboard_rankings_board_read_idx
  on public.leaderboard_rankings (brokerage_id, scope, metric_type, period_label, rank_position);

-- The populator's per-tenant ledger scan.
create index if not exists agent_points_log_brokerage_created_idx
  on public.agent_points_log (brokerage_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. (F) SEED THE PLATFORM-DEFAULT BADGE CATALOG.
--    Modest and real: five rungs, all awarded by the ONE awarder that exists
--    (checkAndAwardBadges, on a points total), at the thresholds of the ONE tier
--    ladder (lib/gamification/tiers.ts). A badge whose trigger_event named an event
--    nothing emits would be exactly the inert catalog this migration is fixing.
insert into public.gamification_badges
  (brokerage_id, badge_name, badge_description, badge_icon, badge_tier, badge_category,
   required_points, trigger_event, is_active)
values
  (null, 'First Steps',      'Your first 100 points on the board.',                    'sparkles',   'bronze',   'milestone',   100,   'points_threshold', true),
  (null, 'Bronze Producer',  'Reached 500 points — the first tier.',                   'award',      'bronze',   'milestone',   500,   'points_threshold', true),
  (null, 'Silver Producer',  'Reached 2,500 points.',                                  'medal',      'silver',   'milestone',   2500,  'points_threshold', true),
  (null, 'Gold Producer',    'Reached 10,000 points.',                                 'trophy',     'gold',     'milestone',   10000, 'points_threshold', true),
  (null, 'Platinum Circle',  'Reached 25,000 points — the top of the ladder.',         'crown',      'platinum', 'milestone',   25000, 'points_threshold', true)
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- POSTCONDITIONS. Stated literally, then verified.
do $$
declare
  v_n int;
  v_txt text;
begin
  -- (A) the forging door
  select coalesce(with_check, '') into v_txt
  from pg_policies
  where schemaname = 'public' and tablename = 'agent_points_log' and cmd = 'INSERT'
    and policyname = 'agent_points_log_insert';
  if v_txt is null or v_txt = '' then
    raise exception 'm484: agent_points_log_insert is missing after the rebuild';
  end if;
  if v_txt !~ 'is_tenant_staff_seat' or v_txt !~ 'current_user_brokerage_id' or v_txt !~ 'current_user_agent_id' then
    raise exception 'm484: agent_points_log_insert is missing its seat, tenant or own-record test — it reads %', v_txt;
  end if;

  -- (B) no untenanted ledger row can be written again
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_points_log'
      and column_name = 'brokerage_id' and is_nullable = 'YES'
  ) then
    raise exception 'm484: agent_points_log.brokerage_id is still nullable';
  end if;

  -- (C) the one award path exists and is a definer
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'award_agent_points' and p.prosecdef
  ) then
    raise exception 'm484: public.award_agent_points() is missing or is not SECURITY DEFINER';
  end if;

  -- (D) one reward ledger
  if to_regclass('public.achievements') is not null or to_regclass('public.agent_achievements') is not null then
    raise exception 'm484: the duplicate achievements tables are still present';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gamification_badges' and column_name = 'badge_category'
  ) then
    raise exception 'm484: gamification_badges.badge_category was not added';
  end if;

  -- (E) the narrowed vocabulary
  select count(*) into v_n
  from pg_constraint
  where conrelid = 'public.leaderboard_rankings'::regclass
    and conname in ('leaderboard_rankings_scope_check','leaderboard_rankings_metric_type_check','leaderboard_rankings_team_scope_check');
  if v_n <> 3 then
    raise exception 'm484: expected 3 leaderboard_rankings CHECK constraints, found %', v_n;
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.leaderboard_rankings'::regclass
      and conname = 'leaderboard_rankings_scope_check'
      and pg_get_constraintdef(oid) like '%agent%'
  ) then
    raise exception 'm484: the scope CHECK still admits agent';
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.leaderboard_rankings'::regclass
      and conname = 'leaderboard_rankings_metric_type_check'
      and pg_get_constraintdef(oid) like '%revenue%'
  ) then
    raise exception 'm484: the metric CHECK still admits revenue';
  end if;

  -- (F) awards are now possible at all
  select count(*) into v_n from public.gamification_badges where brokerage_id is null and is_active;
  if v_n < 5 then
    raise exception 'm484: expected at least 5 active platform-default badges, found %', v_n;
  end if;

  raise notice 'm484: all postconditions hold';
end $$;

-- The state a reviewer should see afterwards.
select 'platform_default_badges' as fact, count(*)::text as value from public.gamification_badges where brokerage_id is null
union all
select 'agent_points_log_brokerage_nullable',
       (select is_nullable::text from information_schema.columns
         where table_schema='public' and table_name='agent_points_log' and column_name='brokerage_id')
union all
select 'award_agent_points_exists',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='award_agent_points')
union all
select 'leaderboard_scope_check',
       (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid='public.leaderboard_rankings'::regclass and conname='leaderboard_rankings_scope_check')
union all
select 'leaderboard_metric_check',
       (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid='public.leaderboard_rankings'::regclass and conname='leaderboard_rankings_metric_type_check')
union all
select 'achievements_tables_remaining',
       (select count(*)::text from information_schema.tables
         where table_schema='public' and table_name in ('achievements','agent_achievements'));

-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DELIBERATELY DOES NOT DO:
--   * It does not populate leaderboard_rankings. That is the populator's job
--     (lib/recruiting/leaderboard.ts, on the weekly recruit-outreach cron); a board
--     seeded by a migration would be stale the moment it landed.
--   * It does not touch agents.career_tier or lib/recruiting/career-tier.ts. That is
--     a PRODUCTION ladder over closed deals — a different fact from engagement
--     points, and not a duplicate of the tier ladder this lane consolidated.
--   * It does not tighten agent_points_log UPDATE/DELETE — both are already
--     is_platform_admin() only.
--   * It does not add a UNIQUE on agent_badges; agent_badges_unique(agent_id,
--     badge_id) already exists and is what makes awardBadge idempotent.
