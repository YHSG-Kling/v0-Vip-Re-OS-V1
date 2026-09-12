-- m461 — commission caps for the BROKERAGE and the TEAM, and the reason the
-- agent cap has been silently unenforced.
--
-- OWNER RULING: "brokerage and teams may also have commission caps."
--
-- ══ WHAT A CAP IS HERE ═════════════════════════════════════════════════════
--
-- A cap is a CEILING ON WHAT AN ENTITY COLLECTS from an agent in an anniversary
-- year. lib/commission/waterfall/07-apply-cap.ts says it in its own header:
-- "Cap tracks brokerage's cumulative earnings, NOT agent's" — once the brokerage
-- has taken cap_amount, its share drops to $0 and the agent keeps the rest.
--
-- Today only the BROKERAGE's take is capped. The TEAM's take is not: stage 08
-- applies the team-lead override with no ceiling at all, so a team keeps
-- collecting for ever while the brokerage stops. That asymmetry is what this
-- migration closes, plus the brokerage-level DEFAULT the owner asked for.
--
-- ══ THE DEFECT FOUND WHILE MEASURING ═══════════════════════════════════════
--
-- THREE places store an agent's cap amount:
--
--   agent_cap_tracking.cap_amount        the LEDGER the waterfall actually reads
--   agent_commission_profiles.cap_amount the per-agent configured override
--   agents.cap_amount / cap_progress     a third copy
--
-- app/actions/ai-financial-management.ts:291 already declares the winner —
-- "cap state is owned by agent_cap_tracking (the canonical ledger)" — but the
-- consolidation was never finished. app/actions/agents.ts:280 still WRITES
-- agents.cap_amount when an agent is created, and app/actions/admin/agent-360.ts:133
-- still reads it.
--
-- MEASURED on the live database, and this is the part that matters:
--
--   agent c0000000-…-0002   cap_amount 150000   agent_cap_tracking rows: 0
--   agent c0000000-…-0004   cap_amount 100000   agent_cap_tracking rows: 0
--   agent c0000000-…-0005   cap_amount 100000   agent_cap_tracking rows: 1
--   agent c0000000-…-0007   cap_amount 100000   agent_cap_tracking rows: 0
--
-- THREE OF THE FOUR CAPPED AGENTS HAVE NO LEDGER ROW. 07-apply-cap.ts finds no
-- tracking record, returns capStatus 'n/a', and never caps them. A broker set a
-- cap on the agent record, the screen showed it, and the commission engine has
-- never once enforced it. That is not a schema tidy-up; it is money.
--
-- The fix is a SEEDER, not a fourth column: a cap configured anywhere resolves
-- into the ledger the engine reads.
--
-- ══ PART 1 — the brokerage-level default ═══════════════════════════════════
--
-- This is the SETTING (owner ruling: settings is where a brokerage configures
-- itself). It does not replace the per-agent ledger; it seeds it, so a brokerage
-- states its cap once instead of re-typing it into every agent.
alter table public.brokerages
  add column if not exists default_cap_amount numeric(12,2);

alter table public.brokerages
  add column if not exists default_cap_anniversary_basis text
    default 'agent_start_date';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brokerages_default_cap_anniversary_basis_check'
  ) then
    alter table public.brokerages
      add constraint brokerages_default_cap_anniversary_basis_check
      check (default_cap_anniversary_basis in ('agent_start_date','calendar_year','brokerage_fiscal_year'));
  end if;
end $$;

comment on column public.brokerages.default_cap_amount is
  'Brokerage-wide DEFAULT cap: what the brokerage collects from an agent per anniversary year before its share drops to $0. Seeds agent_cap_tracking; agent_commission_profiles.cap_amount overrides it per agent.';
comment on column public.brokerages.default_cap_anniversary_basis is
  'Which 12-month window a cap resets on. agent_start_date = each agent''s own anniversary (the industry default); calendar_year = 1 Jan; brokerage_fiscal_year = the brokerage''s own year.';

-- ══ PART 2 — the team cap ══════════════════════════════════════════════════
--
-- teams already carries team_split_type / team_split_percent / team_split_value,
-- which lib/commission/waterfall/08-team-split.ts turns into the team lead's cut
-- of the agent's net. cap_amount is the ceiling on the SUM of those cuts across
-- an anniversary year — the same shape as the brokerage cap, one level down.
alter table public.teams
  add column if not exists cap_amount numeric(12,2);

comment on column public.teams.cap_amount is
  'Ceiling on what this TEAM collects from each of its agents per anniversary year, via the team split. NULL = uncapped, which is what every team was before m461.';

-- The per-agent ledger for that ceiling. Deliberately a mirror of
-- agent_cap_tracking rather than a new shape: the two are the same question at
-- two levels, and the waterfall reads them the same way.
create table if not exists public.team_cap_tracking (
  id                uuid primary key default gen_random_uuid(),
  brokerage_id      uuid not null references public.brokerages(id) on delete cascade,
  team_id           uuid not null references public.teams(id)      on delete cascade,
  agent_id          uuid not null references public.agents(id)     on delete cascade,
  anniversary_start date not null,
  anniversary_end   date not null,
  cap_amount        numeric(12,2) not null,
  cap_paid_to_date  numeric(12,2) not null default 0,
  is_capped         boolean       not null default false,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint team_cap_tracking_window_check check (anniversary_end > anniversary_start)
);

-- One ledger row per (team, agent, window). agent_cap_tracking has NO such
-- constraint, which is why 07-apply-cap.ts has to reach for .maybeSingle() over a
-- date-range filter and would throw if a second overlapping row ever appeared.
-- This table does not repeat that.
create unique index if not exists team_cap_tracking_agent_window_key
  on public.team_cap_tracking (team_id, agent_id, anniversary_start);

create index if not exists team_cap_tracking_lookup_idx
  on public.team_cap_tracking (agent_id, brokerage_id, anniversary_start, anniversary_end);

alter table public.team_cap_tracking enable row level security;

-- READ: anyone in the tenant may see it — an agent must be able to see their own
-- progress toward the team cap, and the team P&L surfaces read it.
create policy team_cap_tracking_tenant_select on public.team_cap_tracking
  for select to authenticated
  using (brokerage_id = public.current_user_brokerage_id());

-- WRITE: this is a MONEY LEDGER. The commission engine writes it on the service
-- client (which bypasses RLS entirely), so the only reason to admit a session
-- writer is administrative correction — and that is a brokerage-admin act, never
-- an agent's and never a team lead's. m457's lesson applies: the tenant anchor is
-- repeated in WITH CHECK so a row cannot be moved to another brokerage.
create policy team_cap_tracking_admin_insert on public.team_cap_tracking
  for insert to authenticated
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy team_cap_tracking_admin_update on public.team_cap_tracking
  for update to authenticated
  using      (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin())
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy team_cap_tracking_admin_delete on public.team_cap_tracking
  for delete to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

-- ══ PART 3 — the three unenforced caps get their ledger rows ═══════════════
--
-- Backfill, not a rewrite: for every agent that carries a cap on the agents row
-- and has NO ledger row covering today, create the row the engine needs.
--
-- TWO THINGS THIS HAD TO GET RIGHT, and the first draft got both wrong:
--
--   · `agents.start_date` DOES NOT EXIST. Only created_at does. Writing an
--     anniversary off a phantom column would have made this migration an
--     instance of the exact defect class it exists to clean up.
--
--   · The window must CONTAIN TODAY. 07-apply-cap.ts finds its row with
--     `anniversary_start <= today AND anniversary_end >= today`, so anchoring
--     naively on the join date would produce a window that closed months ago
--     for any agent older than a year — a ledger row that exists and still
--     never matches, which is indistinguishable from the bug being fixed.
--     The start is therefore rolled forward by whole elapsed years.
--
-- cap_paid_to_date starts at the agents.cap_progress the record already claims,
-- so a broker who has been watching that number does not see it reset to zero.
--
-- (team_cap_tracking is NOT backfilled and starts empty: no team has ever had a
-- cap, so there is nothing to carry forward. Rows appear when a lead sets one.)
insert into public.agent_cap_tracking (agent_id, brokerage_id, anniversary_start, anniversary_end, cap_amount, cap_paid_to_date, is_capped)
select a.id,
       a.brokerage_id,
       (a.created_at::date
         + (greatest(extract(year from age(current_date, a.created_at::date))::int, 0) * interval '1 year'))::date
         as anniversary_start,
       (a.created_at::date
         + ((greatest(extract(year from age(current_date, a.created_at::date))::int, 0) + 1) * interval '1 year'))::date
         as anniversary_end,
       a.cap_amount,
       coalesce(a.cap_progress, 0),
       coalesce(a.cap_progress, 0) >= a.cap_amount
from public.agents a
where a.cap_amount is not null
  and a.cap_amount > 0
  and not exists (
    select 1 from public.agent_cap_tracking t
    where t.agent_id = a.id
      and t.brokerage_id = a.brokerage_id
      and t.anniversary_start <= current_date
      and t.anniversary_end   >= current_date
  );

-- ══ NOT DROPPED HERE, AND THAT IS DELIBERATE ═══════════════════════════════
--
-- agents.cap_amount and agents.cap_progress are the losing copy and they are
-- going. They are NOT dropped in this migration, because two code paths still
-- touch them — app/actions/agents.ts:280 writes cap_amount when an agent is
-- created, and app/actions/admin/agent-360.ts:133 reads both — and dropping a
-- column out from under live code is how a migration turns a data problem into
-- an outage. The repoint lands in this same wave; the DROP is written only after
-- the repoint is verified, so the two facts stay separable if either has to be
-- reverted. (That drop is m463 — m462 was claimed by the territory work in the
-- same wave.)

-- ══ MEASURED AFTER ═════════════════════════════════════════════════════════
--
-- Every capped agent now has a ledger row whose window CONTAINS today, which is
-- the only condition under which 07-apply-cap.ts can see it:
--
--   agent …0002   cap 150000   window 2026-03-31 → 2027-03-31   engine sees it: true
--   agent …0004   cap 100000   window 2026-03-31 → 2027-03-31   engine sees it: true
--   agent …0005   cap 100000   window 2026-01-01 → 2027-01-01   engine sees it: true
--   agent …0007   cap 100000   window 2026-03-31 → 2027-03-31   engine sees it: true
--
-- Three of those four had NO ledger row before this migration and were therefore
-- uncapped in practice.
--
-- ONE DISAGREEMENT LEFT STANDING, ON PURPOSE. Agent …0005 already had a ledger
-- row, and it says cap_amount 80000 with 72500 paid — while agents.cap_amount
-- says 100000. The backfill only fills GAPS; it does not overwrite the ledger,
-- because the ledger is the authority and 72500 of real paid-to-date history
-- sits in it. So that agent is capped at 80000, not 100000.
--
-- Which of those two numbers a broker believes is exactly the argument for
-- finishing the consolidation rather than leaving three copies alive. It is
-- reported here rather than silently reconciled: picking one would be inventing
-- a fact about somebody's compensation.

-- ══ MEASURED AFTER — team_cap_tracking, proved behaviourally ═══════════════
--
-- The backfill above was verified by re-reading the ledger. The NEW table's
-- constraints and policies are verified the only way that means anything: by
-- three different live sessions trying to break them. Throwaway row, deleted at
-- the end. Residue 0, and the table is back to the 0 rows it starts with.
--
--   as admin@vip.demo (a brokerage admin of VIP Premier Realty)
--   A  writes a team cap ledger row .......................... 1 row
--   B  a SECOND row for the same (team, agent, window) ....... REFUSED 23505
--   C  a window that ends before it starts ................... REFUSED 23514
--   D  stamps the row with ANOTHER brokerage's id ............ REFUSED 42501
--   E  MOVES the existing row to another brokerage ........... REFUSED 42501
--
--   as agent@vip.demo (an ordinary agent of the same brokerage)
--   F  reads their own team-cap progress ...................... 1 row
--   G  erases their own cap_paid_to_date ...................... 0 rows
--   H  deletes the ledger row ................................. 0 rows
--
--   as admin@yourbrokerage.com (an admin of the OTHER tenant)
--   I  reads VIP's ledger ..................................... 0 rows
--   ·  residue after cleanup .................................. 0
--
-- B is what agent_cap_tracking still lacks, and the reason 07-apply-cap.ts has
-- to reach for .maybeSingle() over a date range — a call that THROWS rather than
-- picks if a second overlapping row ever appears. Here the database refuses the
-- second row instead of leaving the engine to trip over it.
--
-- D and E are the m448 lesson holding: a tenant anchor in USING alone stops you
-- reading another tenant's row but not MOVING your own into theirs. The anchor
-- is repeated in WITH CHECK, so E is refused too.
--
-- F beside G/H is the whole shape of this table's authority. An agent must be
-- able to SEE their progress toward the ceiling — it is their own compensation —
-- and must not be able to move it. Note G and H return ZERO ROWS rather than an
-- error: an RLS refusal on UPDATE and DELETE is silent, which is exactly why
-- every write in the app layer checks the row count instead of trusting a null
-- error. F returning 1 is what proves G's 0 was the policy and not an empty table.

do $$
begin
  raise notice 'm461: a brokerage can set a default cap, a team can cap what it collects, and the % agent caps that existed only on the agents row now have the ledger row the commission engine actually reads.',
    (select count(*) from public.agents where cap_amount is not null and cap_amount > 0);
end $$;
