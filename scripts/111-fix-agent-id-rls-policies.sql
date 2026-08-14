-- =====================================================
-- MIGRATION 111: FIX AGENT_ID RLS POLICIES
-- =====================================================
-- Root Bug: contacts.agent_id, transactions.agent_id, listings.agent_id etc.
-- all store agents.id (from the agents table), NOT auth.uid() (= users.id).
-- Old policies used agent_id = auth.uid() which always returned false for
-- every agent → agents saw zero rows from their own data.
--
-- Also adds contact_user_id FK column to contacts so is_self_contact() works.
--
-- IMPORTANT: auth schema functions (auth.agent_id() etc.) must be applied
-- via the Supabase Dashboard SQL editor (superuser required) using:
--   supabase/rls-governance/014-fix-agent-id-rls.sql
--
-- This script covers only policy DROP + CREATE (works via project database URL).
-- =====================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0: Add contact_user_id FK to contacts table
-- Needed so contacts can be linked to a user account for self-visibility
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS contact_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_contact_user_id ON contacts(contact_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: CONTACTS TABLE
-- Drop old broken policies by their live names, then recreate correct ones
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop all old agent-related contact policies (both old names and new names)
DROP POLICY IF EXISTS "Users can view their contacts"          ON contacts;
DROP POLICY IF EXISTS "users_view_own_contacts"                ON contacts;
DROP POLICY IF EXISTS "users_insert_contacts"                  ON contacts;
DROP POLICY IF EXISTS "users_update_own_contacts"              ON contacts;
DROP POLICY IF EXISTS "users_delete_own_contacts"              ON contacts;
DROP POLICY IF EXISTS "admins_view_all_contacts"               ON contacts;
DROP POLICY IF EXISTS "brokers_view_team_contacts"             ON contacts;
DROP POLICY IF EXISTS "team_leader_read_team_contacts"         ON contacts;
DROP POLICY IF EXISTS "agent_read_own_contacts"                ON contacts;
DROP POLICY IF EXISTS "agent_insert_own_contacts"              ON contacts;
DROP POLICY IF EXISTS "agent_update_own_contacts"              ON contacts;
DROP POLICY IF EXISTS "admin_read_all_contacts"                ON contacts;
DROP POLICY IF EXISTS "broker_read_brokerage_contacts"         ON contacts;
DROP POLICY IF EXISTS "compliance_read_brokerage_contacts"     ON contacts;
DROP POLICY IF EXISTS "tc_read_transaction_contacts"           ON contacts;
DROP POLICY IF EXISTS "contact_read_self"                      ON contacts;
DROP POLICY IF EXISTS "admin_insert_contacts"                  ON contacts;
DROP POLICY IF EXISTS "broker_insert_contacts"                 ON contacts;
DROP POLICY IF EXISTS "admin_update_contacts"                  ON contacts;
DROP POLICY IF EXISTS "broker_update_brokerage_contacts"       ON contacts;
DROP POLICY IF EXISTS "agent_update_own_contacts"              ON contacts;
DROP POLICY IF EXISTS "tc_update_contact_communication"        ON contacts;
DROP POLICY IF EXISTS "contact_update_self_limited"            ON contacts;
DROP POLICY IF EXISTS "admin_delete_contacts"                  ON contacts;
DROP POLICY IF EXISTS "broker_delete_brokerage_contacts"       ON contacts;
DROP POLICY IF EXISTS "users_delete_own_contacts"              ON contacts;

-- Admin: read all contacts
CREATE POLICY "admin_read_all_contacts"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin')
  );

-- Broker: read all contacts in their brokerage
CREATE POLICY "broker_read_brokerage_contacts"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Compliance manager: read contacts in brokerage
CREATE POLICY "compliance_read_brokerage_contacts"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'compliance_manager'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- TC: read contacts in brokerage
CREATE POLICY "tc_read_brokerage_contacts"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'transaction_coordinator'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Team Leader: join agents -> users for correct team resolution
-- contacts.agent_id = agents.id (NOT users.id)
CREATE POLICY "team_leader_read_team_contacts"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'team_leader'
    AND (
      team_id = (SELECT team_id FROM users WHERE id = auth.uid())
      OR agent_id IN (
        SELECT a.id FROM agents a
        JOIN users u ON a.user_id = u.id
        WHERE u.team_id = (SELECT team_id FROM users WHERE id = auth.uid())
      )
    )
  );

-- Agent SELECT: contacts.agent_id = agents.id resolved via subquery
CREATE POLICY "agent_read_own_contacts"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
  );

-- Contact (self): read only their own contact record via contact_user_id FK
CREATE POLICY "contact_read_self"
  ON contacts FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'contact'
    AND contact_user_id = auth.uid()
  );

-- Admin INSERT
CREATE POLICY "admin_insert_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin')
  );

-- Broker INSERT
CREATE POLICY "broker_insert_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Agent INSERT: contacts.agent_id = agents.id
CREATE POLICY "agent_insert_own_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
    AND (
      agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
      OR agent_id IS NULL
    )
  );

-- Admin UPDATE
CREATE POLICY "admin_update_contacts"
  ON contacts FOR UPDATE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin')
  );

-- Broker UPDATE
CREATE POLICY "broker_update_brokerage_contacts"
  ON contacts FOR UPDATE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Agent UPDATE: contacts.agent_id = agents.id
CREATE POLICY "agent_update_own_contacts"
  ON contacts FOR UPDATE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
  );

-- Admin DELETE
CREATE POLICY "admin_delete_contacts"
  ON contacts FOR DELETE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin')
  );

-- Broker DELETE
CREATE POLICY "broker_delete_brokerage_contacts"
  ON contacts FOR DELETE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: TRANSACTIONS TABLE
-- Live names: users_view_own_transactions, users_insert_transactions, etc.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view their transactions"        ON transactions;
DROP POLICY IF EXISTS "users_view_own_transactions"              ON transactions;
DROP POLICY IF EXISTS "users_insert_transactions"                ON transactions;
DROP POLICY IF EXISTS "users_update_own_transactions"            ON transactions;
DROP POLICY IF EXISTS "admins_view_all_transactions"             ON transactions;
DROP POLICY IF EXISTS "agent_read_own_transactions"              ON transactions;
DROP POLICY IF EXISTS "team_leader_read_team_transactions"       ON transactions;
DROP POLICY IF EXISTS "agent_insert_own_transactions"            ON transactions;
DROP POLICY IF EXISTS "agent_update_own_transactions"            ON transactions;

-- Agent SELECT: all *_agent_id columns store agents.id
CREATE POLICY "agent_read_own_transactions"
  ON transactions FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND (
      agent_id        = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1) OR
      seller_agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1) OR
      buyer_agent_id  = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
    )
  );

-- Team Lead (m440). Same spelling defect and same four-way team problem as the
-- listings policy above; all three agent columns FK agents(id), so each is asked
-- the row's-team question through public.agent_team_id().
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

-- Admin SELECT
CREATE POLICY "admins_view_all_transactions"
  ON transactions FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin')
  );

-- Agent INSERT: *_agent_id = agents.id
CREATE POLICY "agent_insert_own_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
    AND (
      agent_id        = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1) OR
      seller_agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1) OR
      buyer_agent_id  = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
    )
  );

-- Agent UPDATE: *_agent_id = agents.id
CREATE POLICY "agent_update_own_transactions"
  ON transactions FOR UPDATE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND (
      agent_id        = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1) OR
      seller_agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1) OR
      buyer_agent_id  = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
    )
  );

-- Agent INSERT (general — needed since live schema has users_insert_transactions)
CREATE POLICY "users_insert_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: OFFERS TABLE — agent_id stores agents.id
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "agent_manage_offers" ON offers;

CREATE POLICY "agent_manage_offers"
  ON offers FOR ALL
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND (
      agent_id IN (
        SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1
      ) OR
      transaction_id IN (
        SELECT id FROM transactions
        WHERE agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
      ) OR
      listing_id IN (
        SELECT id FROM listings
        WHERE agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: COMMISSION_CALCULATIONS TABLE — agent_id stores agents.id
-- (commissions table is named agent_commissions in live DB — skip old name)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "agent_read_own_commission_calculations" ON commission_calculations;

CREATE POLICY "agent_read_own_commission_calculations"
  ON commission_calculations FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: LISTINGS TABLE
-- Live names: users_view_own_listings, users_insert_listings, etc.
-- Replace all with correct agent_id resolution
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_view_own_listings"               ON listings;
DROP POLICY IF EXISTS "users_insert_listings"                 ON listings;
DROP POLICY IF EXISTS "users_update_own_listings"             ON listings;
DROP POLICY IF EXISTS "users_delete_own_listings"             ON listings;
DROP POLICY IF EXISTS "admins_view_all_listings"              ON listings;
DROP POLICY IF EXISTS "brokers_view_team_listings"            ON listings;
DROP POLICY IF EXISTS "agents_view_brokerage_listings"        ON listings;
DROP POLICY IF EXISTS "brokers_view_all_listings"             ON listings;
DROP POLICY IF EXISTS "tc_view_transaction_listings"          ON listings;
DROP POLICY IF EXISTS "agents_create_listings"                ON listings;
DROP POLICY IF EXISTS "brokers_create_listings"               ON listings;
DROP POLICY IF EXISTS "admins_create_listings"                ON listings;
DROP POLICY IF EXISTS "agents_update_own_listings"            ON listings;
DROP POLICY IF EXISTS "brokers_update_brokerage_listings"     ON listings;
DROP POLICY IF EXISTS "admins_update_all_listings"            ON listings;
DROP POLICY IF EXISTS "brokers_delete_brokerage_listings"     ON listings;
DROP POLICY IF EXISTS "admins_delete_all_listings"            ON listings;
DROP POLICY IF EXISTS "admin_read_all_listings"               ON listings;
DROP POLICY IF EXISTS "broker_read_brokerage_listings"        ON listings;
DROP POLICY IF EXISTS "agent_read_own_listings"               ON listings;
DROP POLICY IF EXISTS "team_leader_read_team_listings"        ON listings;
DROP POLICY IF EXISTS "compliance_read_brokerage_listings"    ON listings;
DROP POLICY IF EXISTS "tc_read_brokerage_listings"            ON listings;
DROP POLICY IF EXISTS "agent_insert_own_listings"             ON listings;
DROP POLICY IF EXISTS "broker_insert_listings"                ON listings;
DROP POLICY IF EXISTS "admin_insert_listings"                 ON listings;
DROP POLICY IF EXISTS "agent_update_own_listings"             ON listings;
DROP POLICY IF EXISTS "broker_update_brokerage_listings"      ON listings;
DROP POLICY IF EXISTS "admin_update_listings"                 ON listings;
DROP POLICY IF EXISTS "broker_delete_brokerage_listings"      ON listings;
DROP POLICY IF EXISTS "admin_delete_listings"                 ON listings;

-- Admin
CREATE POLICY "admin_read_all_listings"
  ON listings FOR SELECT
  USING ((SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin'));

CREATE POLICY "admin_insert_listings"
  ON listings FOR INSERT
  WITH CHECK ((SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin'));

CREATE POLICY "admin_update_listings"
  ON listings FOR UPDATE
  USING ((SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin'))
  WITH CHECK ((SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin'));

CREATE POLICY "admin_delete_listings"
  ON listings FOR DELETE
  USING ((SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin'));

-- Broker: brokerage-scoped
CREATE POLICY "broker_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "broker_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "broker_update_brokerage_listings"
  ON listings FOR UPDATE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  )
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

CREATE POLICY "broker_delete_brokerage_listings"
  ON listings FOR DELETE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner')
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Compliance Officer (m440). This block used to inline `user_type =
-- 'compliance_manager'`, a value users_user_type_check cannot store, so the
-- policy it created granted nothing to anybody. The spelling came from
-- auth.is_compliance_manager() in supabase/rls-governance/000-helper-functions.sql,
-- which was never installed. public.is_compliance_officer_role() is the built
-- helper and already folds both spellings; has_brokerage_access() is the house
-- tenant anchor and is FALSE for a NULL brokerage_id.
CREATE POLICY "compliance_read_brokerage_listings"
  ON listings FOR SELECT TO authenticated
  USING (
    public.is_compliance_officer_role()
    AND public.has_brokerage_access(brokerage_id)
  );

-- TC (m440). Same defect, same cause: 'transaction_coordinator' is the legacy
-- spelling lib/security/types.ts LEGACY_ROLE_MAP folds onto 'tc', and the CHECK
-- stores only 'tc'. public.is_tc_role() is the named helper.
CREATE POLICY "tc_read_brokerage_listings"
  ON listings FOR SELECT TO authenticated
  USING (
    public.is_tc_role()
    AND public.has_brokerage_access(brokerage_id)
  );

-- Agent SELECT: brokerage-scoped (agents need all brokerage listings for MLS/co-op)
CREATE POLICY "agent_read_own_listings"
  ON listings FOR SELECT
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Agent INSERT: listings.agent_id = agents.id
CREATE POLICY "agent_insert_own_listings"
  ON listings FOR INSERT
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
    AND (
      agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
      OR agent_id IS NULL
    )
  );

-- Agent UPDATE: only own listings — listings.agent_id = agents.id
CREATE POLICY "agent_update_own_listings"
  ON listings FOR UPDATE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
  )
  WITH CHECK (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- Agent DELETE: only own listings
CREATE POLICY "agent_delete_own_listings"
  ON listings FOR DELETE
  USING (
    (SELECT user_type FROM users WHERE id = auth.uid()) = 'agent'
    AND agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
  );

-- Team Lead (m440). THREE defects in the original, all removed:
--   · 'team_leader' is unstorable — the CHECK stores 'team_lead'.
--   · the first disjunct was `brokerage_id = <the caller's brokerage>`, i.e. the
--     WHOLE brokerage, which contradicts the owner ruling "teams should only see
--     their own board" and made the team clause beside it decoration.
--   · it resolved the team through users.team_id — one of the FOUR places a team
--     is recorded and the one that is NULL for every live user. m431's
--     resolve_team_id() is THE ONE RULE; current_user_team_id() is the reader's
--     side and agent_team_id(agents.id) is the row's side, so both are decided by
--     identical logic. NULL is fail-closed: no team resolves to no rows, never to
--     the brokerage.
CREATE POLICY "team_leader_read_team_listings"
  ON listings FOR SELECT TO authenticated
  USING (
    public.is_team_lead_role()
    AND public.has_brokerage_access(brokerage_id)
    AND public.current_user_team_id() IS NOT NULL
    AND public.agent_team_id(agent_id) = public.current_user_team_id()
  );
