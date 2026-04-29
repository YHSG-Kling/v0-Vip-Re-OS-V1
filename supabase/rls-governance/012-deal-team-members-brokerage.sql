-- ============================================================
-- RLS GOVERNANCE: 012 — deal_team_members brokerage_id + RLS
-- ============================================================
-- IMPORTANT: Policies in this file reference auth.* helper functions
-- that require superuser. The equivalent policy using inline subqueries
-- was applied via scripts/112-deal-team-members-brokerage-rls.sql.
-- This file is the Dashboard-compatible version using auth.* helpers.
-- ============================================================

-- brokerage_id column already exists in live schema (confirmed).
-- Backfill any remaining NULLs from linked transaction:
UPDATE deal_team_members dtm
SET brokerage_id = t.brokerage_id
FROM transactions t
WHERE dtm.transaction_id = t.id
  AND dtm.brokerage_id IS NULL;

-- NOTE: Apply NOT NULL constraint only after verifying backfill:
-- SELECT count(*) FROM deal_team_members WHERE brokerage_id IS NULL;
-- must return 0 before running:
-- ALTER TABLE deal_team_members ALTER COLUMN brokerage_id SET NOT NULL;

ALTER TABLE deal_team_members ENABLE ROW LEVEL SECURITY;

-- Drop and recreate policies idempotently
DROP POLICY IF EXISTS "dtm_brokerage_isolation" ON deal_team_members;
DROP POLICY IF EXISTS "dtm_agent_insert"         ON deal_team_members;
DROP POLICY IF EXISTS "team_members_brokerage_isolation" ON deal_team_members;

-- All-access policy scoped to brokerage
CREATE POLICY "dtm_brokerage_isolation"
  ON deal_team_members
  FOR ALL
  USING (
    brokerage_id = auth.user_brokerage_id()
    OR auth.is_admin()
  );

-- Agent insert guard: agents can only add team members to their own transactions
CREATE POLICY "dtm_agent_insert"
  ON deal_team_members
  FOR INSERT
  WITH CHECK (
    brokerage_id = auth.user_brokerage_id()
    AND (
      auth.is_broker()
      OR auth.is_admin()
      OR transaction_id IN (
        SELECT id FROM transactions
        WHERE agent_id        = auth.agent_id()
           OR seller_agent_id = auth.agent_id()
           OR buyer_agent_id  = auth.agent_id()
      )
    )
  );
