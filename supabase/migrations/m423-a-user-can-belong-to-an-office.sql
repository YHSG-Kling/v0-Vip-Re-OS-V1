-- m423 — an office is an attribute of the PERSON, not of their agent record.
--
-- ── THE DEFECT, AND IT IS STRUCTURAL ─────────────────────────────────────────
--
-- `resolveEgressScope` (lib/kernel/egress-scope.ts) implements an OFFICE ADMIN:
-- an admin WITH a location is pinned to that one office; without one they see
-- the whole brokerage. The Exception Center already relies on it. The office it
-- reads is `agents.location_id`.
--
-- But `requiresAgentRow(userType, tier)` in lib/kernel/tenant-provisioning-spec.ts
-- gives an admin/broker an `agents` row ONLY on the solo_agent and team tiers —
-- deliberately, and the comment says why: a pure-admin owner of a brokerage or
-- multi_location tenant owns no contacts, listings or transactions, so an agents
-- row would be a fiction.
--
-- Put those two together and the result is that ON A multi_location TENANT, THE
-- OFFICE ADMIN CANNOT EXIST. The one tier that has offices is the one tier whose
-- admins have no `agents` row to carry `location_id`. Measured on the live
-- database before writing this: 8 of 13 non-client users have no agents row,
-- including 2 of 3 admins and the team_lead, tc and compliance_officer.
--
-- ── WHY A COLUMN ON `users` AND NOT AN agents ROW ────────────────────────────
--
-- The alternative — manufacture agents rows for multi-location admins so they
-- have somewhere to put an office — would contradict the provisioning spec on
-- purpose, and would put fictitious agents into every agent roster, seat count
-- and production report in the product. Which office a PERSON works out of is a
-- fact about the person. It belongs on `users`.
--
-- `agents.location_id` is NOT removed and NOT migrated. It stays the office of
-- record for producing agents, and the resolver added alongside this migration
-- (lib/kernel/resolve-user-office.ts) reads `users.location_id` FIRST and falls
-- back to it, so nothing that works today changes behaviour.
--
-- ── NULLABLE, AND THAT IS THE DESIGN ─────────────────────────────────────────
--
-- NULL means "not pinned to an office" — which for an admin means they see the
-- whole brokerage, exactly as they do now. That is the correct default for
-- every existing row, so this migration needs no backfill and cannot change any
-- current user's scope. Narrowing is always an explicit act by an admin.
--
-- ON DELETE SET NULL: deleting an office must not delete the person. The office
-- disappears and everyone in it falls back to brokerage-wide, which is the same
-- fail-OPEN direction `deleteLocationAction` already takes for agents.

alter table public.users
  add column if not exists location_id uuid
  references public.locations(id) on delete set null;

comment on column public.users.location_id is
  'Office this person works out of (multi-location brokerages). NULL = not pinned, sees the whole brokerage. Read through lib/kernel/resolve-user-office.ts, which prefers this over agents.location_id — a pure-admin on a brokerage/multi_location tier has NO agents row by design (requiresAgentRow), so agents.location_id alone made the office-admin scope unreachable on the one tier that has offices.';

create index if not exists users_location_id_idx
  on public.users(location_id) where location_id is not null;
