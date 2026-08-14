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
-- MIGRATION 014: FIX AGENT_ID RLS ROOT BUG
-- =====================================================
-- Root Bug: contacts.agent_id, transactions.agent_id, listings.agent_id, etc.
-- all store agents.id (UUID from the agents table), NOT auth.uid() (= users.id).
-- The old policies compared agent_id = auth.uid() which always evaluated false
-- for every agent, causing agents to see zero rows from their own data.
--
-- Fix: auth.agent_id() resolves agents.id for the current users.id.
-- All agent_id comparisons now use auth.agent_id() instead of auth.uid().
-- auth.is_own_agent_id() provided as a safe boolean helper.
-- auth.is_self_contact() and auth.user_contact_id() fixed to use contact_user_id FK.
--
-- Idempotent: DROP IF EXISTS + CREATE OR REPLACE on all objects.
-- Apply via: Supabase SQL editor, supabase db push, or MCP apply_migration.
-- =====================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: NEW + FIXED HELPER FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

-- Resolves agents.id for the currently authenticated user
CREATE OR REPLACE FUNCTION auth.agent_id()
RETURNS UUID AS $$
  SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Safe boolean check: does this agents.id belong to the current user?
CREATE OR REPLACE FUNCTION auth.is_own_agent_id(agent_id_to_check UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM agents
    WHERE id = agent_id_to_check
    AND user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.owns_contact — contacts.agent_id stores agents.id, not users.id
CREATE OR REPLACE FUNCTION auth.owns_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.owns_transaction — *agent_id columns store agents.id, not users.id
CREATE OR REPLACE FUNCTION auth.owns_transaction(transaction_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM transactions
    WHERE id = $1
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.owns_listing — listings.agent_id stores agents.id, not users.id
CREATE OR REPLACE FUNCTION auth.owns_listing(listing_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM listings
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.is_self_contact — use contact_user_id FK, not email JOIN
CREATE OR REPLACE FUNCTION auth.is_self_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND contact_user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.user_contact_id — use contact_user_id FK, not email JOIN
CREATE OR REPLACE FUNCTION auth.user_contact_id()
RETURNS UUID AS $$
  SELECT id FROM contacts
  WHERE contact_user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION auth.agent_id()                          TO authenticated;
GRANT EXECUTE ON FUNCTION auth.is_own_agent_id(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_contact(UUID)                  TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_transaction(UUID)              TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_listing(UUID)                  TO authenticated;
GRANT EXECUTE ON FUNCTION auth.is_self_contact(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION auth.user_contact_id()                   TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: CONTACTS TABLE — drop & recreate broken agent policies
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "team_leader_read_team_contacts"   ON contacts;
DROP POLICY IF EXISTS "agent_read_own_contacts"          ON contacts;
DROP POLICY IF EXISTS "agent_insert_own_contacts"        ON contacts;
DROP POLICY IF EXISTS "agent_update_own_contacts"        ON contacts;
-- interaction_history exists in live DB but has 0 RLS policies (RLS not enabled).
-- Do NOT create policies on it here; managed at application layer only.
-- DROP IF EXISTS is safe even if no policy exists.
DROP POLICY IF EXISTS "agent_manage_interaction_history" ON interaction_history;

-- Team Lead: read the contacts owned by the agents on THEIR team.
--
-- NOTE, because this one is not just a spelling repair: the live database already
-- carries a repaired policy for this capability under a DIFFERENT NAME —
-- `contacts.team_lead_read_team_contacts` (no "er"), which names both spellings
-- and anchors on current_user_brokerage_id(). Creating this one as it stood would
-- have added a SECOND, wider policy beside it rather than replacing it, and
-- permissive policies OR together — so the looser of the two would have decided
-- access. It is repaired here to the same rule so the two cannot disagree, and the
-- DROP above still removes any older copy of this name.
--
-- `contacts.team_id` is read directly and NOT through agent_team_id(): it is the
-- TEAM THE CONTACT BELONGS TO, a property of the row, not a person's membership —
-- so it is compared against the caller's resolved team rather than re-resolved.
CREATE POLICY "team_leader_read_team_contacts"
  ON contacts FOR SELECT TO authenticated
  USING (
    public.is_team_lead_role()
    AND public.has_brokerage_access(brokerage_id)
    AND public.current_user_team_id() IS NOT NULL
    AND (
      team_id = public.current_user_team_id()
      OR public.agent_team_id(agent_id) = public.current_user_team_id()
    )
  );

-- Agent SELECT: contacts.agent_id = auth.agent_id()
CREATE POLICY "agent_read_own_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- Agent INSERT: contacts.agent_id = auth.agent_id()
CREATE POLICY "agent_insert_own_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- Agent UPDATE: contacts.agent_id = auth.agent_id()
CREATE POLICY "agent_update_own_contacts"
  ON contacts FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: TRANSACTIONS TABLE — drop & recreate broken agent policies
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "agent_read_own_transactions"            ON transactions;
DROP POLICY IF EXISTS "team_leader_read_team_transactions"     ON transactions;
DROP POLICY IF EXISTS "agent_insert_own_transactions"          ON transactions;
DROP POLICY IF EXISTS "agent_update_own_transactions"          ON transactions;
DROP POLICY IF EXISTS "agent_manage_offers"                    ON offers;
-- NOTE: Live DB uses "agent_commissions" table (not "commissions")
-- The old "commissions" table doesn't exist — skip DROP to avoid error
DROP POLICY IF EXISTS "agent_read_own_commission_calculations" ON commission_calculations;

-- Agent SELECT: all agent_id columns use auth.agent_id()
CREATE POLICY "agent_read_own_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_agent()
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );

-- Team Lead (m440). Same repair as 004-transactions-policies.sql: the roster comes
-- from public.is_team_lead_role() rather than an inlined 'team_leader' the CHECK
-- cannot store, and the team from m431's ONE rule rather than users.team_id.
CREATE POLICY "team_leader_read_team_transactions"
  ON transactions FOR SELECT TO authenticated
  USING (
    public.is_team_lead_role()
    AND public.has_brokerage_access(brokerage_id)
    AND public.current_user_team_id() IS NOT NULL
    AND (
      public.agent_team_id(agent_id)        = public.current_user_team_id()
      OR public.agent_team_id(seller_agent_id) = public.current_user_team_id()
      OR public.agent_team_id(buyer_agent_id)  = public.current_user_team_id()
    )
  );

-- Agent INSERT: all agent_id columns use auth.agent_id()
CREATE POLICY "agent_insert_own_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );

-- Agent UPDATE: all agent_id columns use auth.agent_id()
CREATE POLICY "agent_update_own_transactions"
  ON transactions FOR UPDATE
  USING (
    auth.is_agent()
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );

-- Offers: agent_id in sub-selects use auth.agent_id()
CREATE POLICY "agent_manage_offers"
  ON offers FOR ALL
  USING (
    auth.is_agent()
    AND (
      transaction_id IN (SELECT id FROM transactions WHERE agent_id = auth.agent_id()) OR
      listing_id IN (SELECT id FROM listings WHERE agent_id = auth.agent_id())
    )
  );

-- agent_commissions: live DB table name (not "commissions")
-- agent_commissions.agent_id stores agents.id
CREATE POLICY "agent_read_own_agent_commissions"
  ON agent_commissions FOR SELECT
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- Commission calculations: via transactions.agent_id
CREATE POLICY "agent_read_own_commission_calculations"
  ON commission_calculations FOR SELECT
  USING (
    auth.is_agent()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE agent_id = auth.agent_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: LISTINGS TABLE — drop auth_helpers policies & recreate with auth.*
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "agents_view_brokerage_listings"     ON listings;
DROP POLICY IF EXISTS "brokers_view_all_listings"          ON listings;
DROP POLICY IF EXISTS "admins_view_all_listings"           ON listings;
DROP POLICY IF EXISTS "tc_view_transaction_listings"       ON listings;
DROP POLICY IF EXISTS "agents_create_listings"             ON listings;
DROP POLICY IF EXISTS "brokers_create_listings"            ON listings;
DROP POLICY IF EXISTS "admins_create_listings"             ON listings;
DROP POLICY IF EXISTS "agents_update_own_listings"         ON listings;
DROP POLICY IF EXISTS "brokers_update_brokerage_listings"  ON listings;
DROP POLICY IF EXISTS "admins_update_all_listings"         ON listings;
DROP POLICY IF EXISTS "brokers_delete_brokerage_listings"  ON listings;
DROP POLICY IF EXISTS "admins_delete_all_listings"         ON listings;
DROP POLICY IF EXISTS "admin_read_all_listings"            ON listings;
DROP POLICY IF EXISTS "broker_read_brokerage_listings"     ON listings;
DROP POLICY IF EXISTS "agent_read_own_listings"            ON listings;
DROP POLICY IF EXISTS "team_leader_read_team_listings"     ON listings;
DROP POLICY IF EXISTS "compliance_read_brokerage_listings" ON listings;
DROP POLICY IF EXISTS "tc_read_brokerage_listings"         ON listings;
DROP POLICY IF EXISTS "agent_insert_own_listings"          ON listings;
DROP POLICY IF EXISTS "broker_insert_listings"             ON listings;
DROP POLICY IF EXISTS "admin_insert_listings"              ON listings;
DROP POLICY IF EXISTS "agent_update_own_listings"          ON listings;
DROP POLICY IF EXISTS "broker_update_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admin_update_listings"              ON listings;
DROP POLICY IF EXISTS "broker_delete_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admin_delete_listings"              ON listings;

-- Admin
CREATE POLICY "admin_read_all_listings"    ON listings FOR SELECT USING (auth.is_admin());
CREATE POLICY "admin_insert_listings"      ON listings FOR INSERT WITH CHECK (auth.is_admin());
CREATE POLICY "admin_update_listings"      ON listings FOR UPDATE USING (auth.is_admin()) WITH CHECK (auth.is_admin());
CREATE POLICY "admin_delete_listings"      ON listings FOR DELETE USING (auth.is_admin());

-- Broker
CREATE POLICY "broker_read_brokerage_listings"
  ON listings FOR SELECT
  USING (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

CREATE POLICY "broker_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

CREATE POLICY "broker_update_brokerage_listings"
  ON listings FOR UPDATE
  USING (auth.is_broker() AND auth.has_brokerage_access(brokerage_id))
  WITH CHECK (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

CREATE POLICY "broker_delete_brokerage_listings"
  ON listings FOR DELETE
  USING (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

-- Compliance
CREATE POLICY "compliance_read_brokerage_listings"
  ON listings FOR SELECT
  USING (public.is_compliance_officer_role() AND public.has_brokerage_access(brokerage_id));

-- TC
CREATE POLICY "tc_read_brokerage_listings"
  ON listings FOR SELECT
  USING (public.is_tc_role() AND public.has_brokerage_access(brokerage_id));

-- Agent SELECT: brokerage-scoped (agents need to see all brokerage listings for MLS)
CREATE POLICY "agent_read_own_listings"
  ON listings FOR SELECT
  USING (auth.is_agent() AND auth.has_brokerage_access(brokerage_id));

-- Agent INSERT: listings.agent_id = auth.agent_id()
CREATE POLICY "agent_insert_own_listings"
  ON listings FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- Agent UPDATE: listings.agent_id = auth.agent_id()
CREATE POLICY "agent_update_own_listings"
  ON listings FOR UPDATE
  USING (auth.is_agent() AND agent_id = auth.agent_id())
  WITH CHECK (auth.is_agent() AND agent_id = auth.agent_id() AND auth.has_brokerage_access(brokerage_id));

-- Team Lead (m440). Same repair as 005-listings-policies.sql, including the one
-- that is not a spelling: the `auth.has_brokerage_access(brokerage_id) OR …`
-- disjunct granted the WHOLE BROKERAGE and made the team clause beside it
-- decoration. Owner ruling: "teams should only see their own board." The tenant
-- test is an AND here, and the team is m431's ONE rule.
CREATE POLICY "team_leader_read_team_listings"
  ON listings FOR SELECT TO authenticated
  USING (
    public.is_team_lead_role()
    AND public.has_brokerage_access(brokerage_id)
    AND public.current_user_team_id() IS NOT NULL
    AND public.agent_team_id(agent_id) = public.current_user_team_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION COMMENT
-- ─────────────────────────────────────────────────────────────────────────────
-- After applying this migration, an authenticated agent should be able to:
--   SELECT * FROM contacts WHERE agent_id = auth.agent_id()  → their records
--   SELECT * FROM listings WHERE agent_id = auth.agent_id()  → their listings
--   SELECT * FROM transactions WHERE agent_id = auth.agent_id() → their deals
-- Previously all of these returned 0 rows because auth.uid() ≠ agents.id
-- =====================================================
