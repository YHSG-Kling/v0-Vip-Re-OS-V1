-- ⚠ m440 — THE ROLE-GATED SELECT POLICIES IN THIS FILE HAVE BEEN REPAIRED.
--
-- The team-lead / TC / compliance-officer SELECT policies below were installed on
-- the live database (through scripts/111-fix-agent-id-rls-policies.sql, which
-- inlines the auth.* helper bodies from 000-helper-functions.sql) gating on
-- 'team_leader', 'transaction_coordinator' and 'compliance_manager' — three
-- user_type values users_user_type_check CANNOT store. Every one of those
-- policies was therefore false for every user who will ever exist, and the tc,
-- compliance-officer and team-lead surfaces read ZERO rows.
--
-- m440 repaired them on the database: the role comes from the built public.*
-- helper (is_tc_role / is_compliance_officer_role / is_team_lead_role, each a
-- POSITIVE roster naming both spellings), the tenant from has_brokerage_access(),
-- and the TEAM from m431's public.current_user_team_id() / public.agent_team_id()
-- rather than users.team_id — which is NULL for every live user and is only one of
-- the four places a team is recorded. m440 also removed the whole-brokerage
-- disjunct that sat beside the team clause and contradicted the owner's ruling
-- that "teams should only see their own board".
--
-- THE BLOCKS BELOW NOW MATCH THAT, so re-running this file reinstalls the repair
-- instead of reinstating the defect. Annotating the risk was not enough: a warning
-- header does not stop a bootstrap script, and this file's own CREATE POLICY text
-- is what actually decides what exists after it runs. m441 asserts the repair on
-- the database and goes red if any of it is undone.
--
-- The public.* helpers are the ones to use in anything added here. The auth.*
-- family in 000-helper-functions.sql has never been installed on this database —
-- that file needs a dashboard superuser connection and was never run — which is
-- precisely how a spelling nothing could store ended up deciding live access.

-- =====================================================
-- RLS GOVERNANCE: LISTINGS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to listing records
-- Tables: listings, listing_media
-- Key Rules:
--   - listings.agent_id stores agents.id (NOT users.id) — use auth.agent_id()
--   - Brokerage isolation is always enforced via brokerage_id
--   - auth_helpers.* was non-existent; all policies now use canonical auth.* schema
-- =====================================================

-- Enable RLS
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

-- Drop all old policies (covers both old auth_helpers and auth naming conventions)
DROP POLICY IF EXISTS "agents_view_brokerage_listings"      ON listings;
DROP POLICY IF EXISTS "brokers_view_all_listings"           ON listings;
DROP POLICY IF EXISTS "admins_view_all_listings"            ON listings;
DROP POLICY IF EXISTS "tc_view_transaction_listings"        ON listings;
DROP POLICY IF EXISTS "agents_create_listings"              ON listings;
DROP POLICY IF EXISTS "brokers_create_listings"             ON listings;
DROP POLICY IF EXISTS "admins_create_listings"              ON listings;
DROP POLICY IF EXISTS "agents_update_own_listings"          ON listings;
DROP POLICY IF EXISTS "brokers_update_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admins_update_all_listings"          ON listings;
DROP POLICY IF EXISTS "brokers_delete_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admins_delete_all_listings"          ON listings;
DROP POLICY IF EXISTS "admin_read_all_listings"             ON listings;
DROP POLICY IF EXISTS "broker_read_brokerage_listings"      ON listings;
DROP POLICY IF EXISTS "agent_read_own_listings"             ON listings;
DROP POLICY IF EXISTS "team_leader_read_team_listings"      ON listings;
DROP POLICY IF EXISTS "compliance_read_brokerage_listings"  ON listings;
DROP POLICY IF EXISTS "tc_read_brokerage_listings"          ON listings;
DROP POLICY IF EXISTS "agent_insert_own_listings"           ON listings;
DROP POLICY IF EXISTS "broker_insert_listings"              ON listings;
DROP POLICY IF EXISTS "admin_insert_listings"               ON listings;
DROP POLICY IF EXISTS "agent_update_own_listings"           ON listings;
DROP POLICY IF EXISTS "broker_update_brokerage_listings"    ON listings;
DROP POLICY IF EXISTS "admin_update_listings"               ON listings;
DROP POLICY IF EXISTS "broker_delete_brokerage_listings"    ON listings;
DROP POLICY IF EXISTS "admin_delete_listings"               ON listings;

-- =====================================================
-- LISTINGS TABLE: SELECT POLICIES
-- =====================================================

-- Admin: Read all listings across all brokerages
CREATE POLICY "admin_read_all_listings"
  ON listings FOR SELECT
  USING (auth.is_admin());

-- Broker: Read all listings in their brokerage
CREATE POLICY "broker_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Compliance Manager: Read all listings in their brokerage (audit)
CREATE POLICY "compliance_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    public.is_compliance_officer_role()
    AND public.has_brokerage_access(brokerage_id)
  );

-- TC: Read listings tied to their brokerage's transactions
CREATE POLICY "tc_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    public.is_tc_role()
    AND public.has_brokerage_access(brokerage_id)
  );

-- Agent: Read own listings + brokerage listings (agents need to see all brokerage listings for MLS/co-op)
-- FIX: listings.agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_read_own_listings"
  ON listings FOR SELECT
  USING (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Team Lead: read the listings of the agents on THEIR team — and no others.
--
-- m440 rewrote this policy on the live database and this block is brought level
-- with it. Three things changed, and each was a defect rather than a preference:
--
--   · `auth.is_team_leader()` inlined `user_type = 'team_leader'`, which
--     users_user_type_check cannot store, so the policy was false for every user
--     who will ever exist. m444 then went further, on the owner's ruling that
--     "a team lead is an agent that runs their own team": there is no role test
--     here AT ALL. Leading is a FACT in teams.team_lead_id, and the live data
--     proves the role column is uncorrelated with it — the real team lead carries
--     user_type='agent', while the one account carrying 'team_lead' runs no team.
--     public.current_user_led_team_id() reads the fact.
--   · the first disjunct was `auth.has_brokerage_access(brokerage_id) OR …`, i.e.
--     the WHOLE BROKERAGE. Had the spelling ever been storable, a team lead would
--     have read every listing in the brokerage and the team clause beside it would
--     have been decoration. Owner ruling: "teams should only see their own board."
--     The tenant test is now an AND, not an OR.
--   · the team was resolved through `users.team_id` — one of FOUR places a team is
--     recorded on this schema, and the one that is NULL for every live user. The
--     row's side is now public.agent_team_id(agents.id), m431's ONE rule. The
--     reader's side is current_user_led_team_id() — the team they RUN — and NOT
--     current_user_team_id(), which returns the team you are ON and would hand
--     every rank-and-file team member the whole team's board.
--
-- NULL is FAIL-CLOSED and the explicit IS NOT NULL guard makes that visible: a
-- team lead with no resolvable team gets an empty board, never the brokerage.
CREATE POLICY "team_leader_read_team_listings"
  ON listings FOR SELECT TO authenticated
  USING (
    public.current_user_led_team_id() IS NOT NULL
    AND public.has_brokerage_access(brokerage_id)
    AND public.agent_team_id(agent_id) = public.current_user_led_team_id()
  );

-- =====================================================
-- LISTINGS TABLE: INSERT POLICIES
-- =====================================================

-- Admin: Insert any listing
CREATE POLICY "admin_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (auth.is_admin());

-- Broker: Insert listings in their brokerage
CREATE POLICY "broker_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Insert listings in their brokerage assigned to themselves
-- FIX: listings.agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_insert_own_listings"
  ON listings FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- =====================================================
-- LISTINGS TABLE: UPDATE POLICIES
-- =====================================================

-- Admin: Update any listing
CREATE POLICY "admin_update_listings"
  ON listings FOR UPDATE
  USING (auth.is_admin())
  WITH CHECK (auth.is_admin());

-- Broker: Update any listing in their brokerage
CREATE POLICY "broker_update_brokerage_listings"
  ON listings FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  )
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Update only their own listings
-- FIX: listings.agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_update_own_listings"
  ON listings FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  )
  WITH CHECK (
    auth.is_agent()
    AND agent_id = auth.agent_id()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- LISTINGS TABLE: DELETE POLICIES
-- =====================================================

-- Admin: Delete any listing
CREATE POLICY "admin_delete_listings"
  ON listings FOR DELETE
  USING (auth.is_admin());

-- Broker: Delete listings in their brokerage (soft-delete preferred via status field)
CREATE POLICY "broker_delete_brokerage_listings"
  ON listings FOR DELETE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- LISTING_MEDIA TABLE POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'listing_media') THEN
    ALTER TABLE listing_media ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "agents_view_listing_media"      ON listing_media;
    DROP POLICY IF EXISTS "agents_create_listing_media"    ON listing_media;
    DROP POLICY IF EXISTS "agents_update_listing_media"    ON listing_media;
    DROP POLICY IF EXISTS "brokers_manage_listing_media"   ON listing_media;
    DROP POLICY IF EXISTS "admins_manage_all_listing_media" ON listing_media;
    DROP POLICY IF EXISTS "agent_read_listing_media"       ON listing_media;
    DROP POLICY IF EXISTS "agent_insert_listing_media"     ON listing_media;
    DROP POLICY IF EXISTS "agent_update_listing_media"     ON listing_media;
    DROP POLICY IF EXISTS "broker_manage_listing_media"    ON listing_media;
    DROP POLICY IF EXISTS "admin_manage_listing_media"     ON listing_media;

    -- Agents can view media for their brokerage's listings
    CREATE POLICY "agent_read_listing_media"
      ON listing_media FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND auth.has_brokerage_access(l.brokerage_id)
        )
      );

    -- Agents can insert/update media for their own listings
    -- FIX: listings.agent_id stores agents.id — use auth.agent_id()
    CREATE POLICY "agent_insert_listing_media"
      ON listing_media FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.agent_id = auth.agent_id()
        )
      );

    CREATE POLICY "agent_update_listing_media"
      ON listing_media FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.agent_id = auth.agent_id()
        )
      );

    -- Brokers can manage all listing media in their brokerage
    CREATE POLICY "broker_manage_listing_media"
      ON listing_media FOR ALL
      USING (
        auth.is_broker()
        AND EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND auth.has_brokerage_access(l.brokerage_id)
        )
      );

    -- Admins can manage all listing media
    CREATE POLICY "admin_manage_listing_media"
      ON listing_media FOR ALL
      USING (auth.is_admin());
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON TABLE listings IS 'RLS Policies Applied: 005-listings-policies.sql (rewritten) — uses canonical auth.* helpers; listings.agent_id is agents.id, not users.id; auth_helpers.* removed.';
