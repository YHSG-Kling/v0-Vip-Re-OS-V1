-- supabase/migrations/m661-one-managing-broker-per-location-and-agent-book-transfers.sql
--
-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m661 — ONE MANAGING BROKER PER BROKERAGE LOCATION, AND THE AGENT-BOOK TRANSFER LEDGER.
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULINGS, VERBATIM (2026-09-24, wave 81A):
--   "a broker who is the broker of record for a brokerage location has to be
--    producing since that person manages the agents of the brokerage. there can
--    only be one managing broker per brokerage location."
--   "make sure the tenant can assign temporarily or permanently another agents
--    books in case an agent leaves or temporarily leaves."
--
-- SCHEMA CHECKED FIRST (scripts/schema-snapshot.ts, scripts/check-vocabularies.ts,
-- scripts/schema-fk-map.ts): public.locations exists (brokerage_id, name, address,
-- city, state) and is the office model — agents.location_id, users.location_id,
-- listings.location_id and contacts.location_id all FK to it. NOTHING on it or on
-- brokerages names a broker of record, and no user_type / role flag says
-- "managing". So the column goes on the LOCATION ROW: a scalar column is one
-- value per row BY CONSTRUCTION, which is the uniqueness rule the owner stated
-- ("only one managing broker per brokerage location") — no second index can
-- restate it, and no jsonb map can hold two. The same person MAY be the
-- managing broker of more than one office (TX: one designated broker per
-- entity acting through every branch; FL: a branch is registered under the
-- brokerage's broker) — so there is deliberately NO uniqueness on the user.
--
-- A tenant with zero locations rows is a single-office brokerage. Its principal
-- office is materialised as ONE locations row the moment a managing broker is
-- assigned (lib/kernel/managing-broker.ts::assignManagingBroker — name = the
-- brokerage's name, address copied from brokerages), so the fact still has one
-- home and the multi-office model needs no second spelling (CLAUDE.md §6).
--
-- WHO MAY HOLD IT is a code rule, kept beside the seat rule that reads it:
-- users.user_type IN (broker, broker_owner) — LICENSED_SEAT_ROLES in
-- lib/kernel/tier-role-matrix.ts. The FK is to users(id) (the seat identity),
-- never agents(id) (the two classes are disjoint, CLAUDE.md §3).
--
-- THE SEAT CONSEQUENCE lives in code, not here: a managing broker ALWAYS
-- consumes a producing seat — roleConsumesSeat(role, { managingBroker: true })
-- is true whatever the tenant's non_producing_user_ids says, and
-- setLicensedProducerExemption refuses to exempt them (fail closed on an
-- unreadable locations row).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS managing_broker_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS managing_broker_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS managing_broker_assigned_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_locations_managing_broker_user
  ON public.locations (brokerage_id, managing_broker_user_id)
  WHERE managing_broker_user_id IS NOT NULL;

COMMENT ON COLUMN public.locations.managing_broker_user_id IS
  'The ONE managing broker (broker of record) of this office — users.id of a broker / broker_owner (owner ruling 2026-09-24, wave 81A: exactly one per brokerage location; always a producing seat). Written only by lib/kernel/managing-broker.ts::assignManagingBroker (tenant commerce admin, audited to lifecycle_events managing_broker_assigned). Read by lib/kernel/seat-usage.ts (the seat meter and the exemption writer) and lib/onboarding/setup-readiness.ts (the managing_broker readiness item). TABLE_MANAGER: recruiting_manager; seat consequence co-owned by finance_manager.';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE AGENT-BOOK TRANSFER LEDGER — the record a TEMPORARY reassignment needs so it
-- can be REVERTED (the original owner is kept HERE, never on the moved rows, so
-- contacts/leads/listings/transactions/tasks carry one owner column each and
-- the agent-facing surfaces keep showing the covering agent as the owner while
-- the window is open). A PERMANENT reassignment stamps a row too, so the
-- transition log is one table for both scopes.
--
-- Row lifecycle: active (temporary, until > now) → reverted (the daily sweep on
-- /api/cron/capacity-guardian moved the still-covered rows back, or an admin
-- reverted early) | permanent (never reverts). `moved` holds the row ids per
-- kind that the transfer actually moved (COUNTED from the .select() of each
-- update, CLAUDE.md §3), and the revert moves back ONLY rows still owned by the
-- covering agent — a row the tenant re-pointed elsewhere during the window is
-- left where the tenant put it and reported as skipped.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_book_transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  from_agent_id     uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  to_agent_id       uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  scope             text NOT NULL CHECK (scope IN ('temporary', 'permanent')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reverted', 'permanent')),
  reason            text,
  until_at          timestamptz,
  moved             jsonb NOT NULL DEFAULT '{}'::jsonb,
  reverted          jsonb,
  created_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  reverted_at       timestamptz,
  reverted_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT agent_book_transfers_distinct_agents CHECK (from_agent_id <> to_agent_id),
  -- A temporary transfer has an end; a permanent one has none and is never 'active'.
  CONSTRAINT agent_book_transfers_scope_shape CHECK (
    (scope = 'temporary' AND until_at IS NOT NULL AND status IN ('active', 'reverted'))
    OR (scope = 'permanent' AND status = 'permanent')
  )
);

-- At most ONE open temporary transfer per away agent: a second cover of the same
-- book would leave two ledgers claiming the same rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_book_transfers_one_active_per_agent
  ON public.agent_book_transfers (brokerage_id, from_agent_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_book_transfers_due
  ON public.agent_book_transfers (until_at)
  WHERE status = 'active';

COMMENT ON TABLE public.agent_book_transfers IS
  'Temporary / permanent reassignment of one agent''s whole book to another (owner ruling 2026-09-24, wave 81A). Written by lib/agents/agent-books.ts::reassignAgentBooks (tenant admin, session tenant) and reverted by lib/agents/agent-books.ts::revertExpiredBookTransfers on the daily /api/cron/capacity-guardian tick or by revertBookTransfer (admin). TABLE_MANAGER: recruiting_manager; co-owned by deal_coordinator (in-flight deals follow the client) and data_steward (identity classes: from/to are agents.id, created_by is users.id).';

ALTER TABLE public.agent_book_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_book_transfers_tenant_select ON public.agent_book_transfers
  FOR SELECT USING (brokerage_id = public.current_user_brokerage_id());
-- Writes are service-role only (the gated server actions + the daily cron).
