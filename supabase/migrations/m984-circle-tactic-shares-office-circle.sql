-- ── APPLIED LIVE 2026-11-20 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 155, lane 155K ── read back: circle_tactic_shares.location_id (uuid, FK locations ON DELETE CASCADE), 6 CHECKs (circle_kind incl. 'office', status, evidence_quality, team_iff, mentorship_iff, office_iff), 5 foreign keys
--
-- m984 — an OFFICE can be a circle for a shared method (directive K4; wave 154 §14 "office-level circles").
--
-- m973 (applied 2026-11-18) let a producer share ONE generalized method with a team, a mentorship or the whole tenant. The
-- office structure already exists — agents.location_id → public.locations (status 'active' | 'archived', brokerage_id NOT NULL)
-- — but a share could not name it. This adds the smallest thing: a nullable location_id and 'office' in the circle_kind CHECK,
-- with the same "kind iff id" rule m973 uses for team and mentorship. Membership is still read LIVE (lib/marketing/circle-tactics.ts
-- circleMemberUserIds / liveCirclesOf: the office row must be this tenant's and active; members are its active agents).
-- No membership class, no new table, nothing cross-tenant. Widens a CHECK; drops no column or index.
--
-- After applying: npm run schema:regen (live-tables, schema-snapshot, schema-fk-map, check-vocabularies) so
-- circle_tactic_shares.circle_kind carries 'office' and location_id is in the snapshot (test:schema-drift reads it).

alter table public.circle_tactic_shares
  add column if not exists location_id uuid references public.locations(id) on delete cascade;

alter table public.circle_tactic_shares drop constraint if exists circle_tactic_shares_circle_kind_check;
alter table public.circle_tactic_shares
  add constraint circle_tactic_shares_circle_kind_check check (circle_kind in ('team', 'mentorship', 'brokerage', 'office'));

alter table public.circle_tactic_shares drop constraint if exists circle_tactic_shares_office_iff;
alter table public.circle_tactic_shares
  add constraint circle_tactic_shares_office_iff check ((circle_kind = 'office') = (location_id is not null));

create index if not exists circle_tactic_shares_location_idx on public.circle_tactic_shares (location_id) where location_id is not null;

comment on column public.circle_tactic_shares.location_id is 'Wave 155 (155K, K4): the office (locations.id) an office share reaches — set iff circle_kind = ''office''. Members are read live: active agents with agents.location_id = this id, office status active, same tenant.';

-- Read-back the integrator runs after applying:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.circle_tactic_shares'::regclass and contype = 'c' order by 1;
--   (expect 6 CHECKs: circle_kind incl. 'office', status, evidence_quality, team_iff, mentorship_iff, office_iff)
