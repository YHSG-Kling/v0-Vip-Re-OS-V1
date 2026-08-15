-- Migration 115: Add RLS SELECT policies to agents table
-- 
-- The agents table has RLS enabled but NO policies, meaning every SELECT
-- by an authenticated user returns 0 rows. This causes getAgentContext()
-- to always resolve agentId as null, breaking all agent-scoped queries.
--
-- Policy design:
--   1. agents_read_own       — an agent can always read their own row (user_id = auth.uid())
--   2. agents_read_brokerage — brokers/admins can read all agents in their brokerage
--   3. agents_insert_own     — agent can insert their own row on signup
--   4. agents_update_own     — agent can update their own row

-- ── SELECT: agent reads own row ───────────────────────────────────────────────
DROP POLICY IF EXISTS "agents_read_own" ON agents;
CREATE POLICY "agents_read_own"
  ON agents FOR SELECT
  USING (user_id = auth.uid());

-- ── SELECT: broker/admin reads all agents in their brokerage ─────────────────
DROP POLICY IF EXISTS "agents_read_brokerage" ON agents;
CREATE POLICY "agents_read_brokerage"
  ON agents FOR SELECT
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
    AND (
      SELECT user_type FROM users WHERE id = auth.uid()
    ) IN ('broker', 'broker_owner', 'admin', 'super_admin', 'superadmin', 'team_lead', 'managing_broker')
  );

-- ── INSERT: agent inserts own row (signup / onboarding) ──────────────────────
DROP POLICY IF EXISTS "agents_insert_own" ON agents;
CREATE POLICY "agents_insert_own"
  ON agents FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ── UPDATE: agent updates own row ────────────────────────────────────────────
DROP POLICY IF EXISTS "agents_update_own" ON agents;
CREATE POLICY "agents_update_own"
  ON agents FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'agents'
ORDER BY policyname;
