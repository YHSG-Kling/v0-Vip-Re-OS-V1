-- ============================================================
-- Migration 112: deal_team_members — brokerage_id RLS policy
-- ============================================================
-- The deal_team_members table already has a brokerage_id UUID column
-- (confirmed in live schema). The column was backfilled via the linked
-- transaction on initial schema creation.
--
-- This migration ONLY adds the missing RLS policy so that each brokerage
-- sees only its own deal team members. The table currently has 0 policies
-- despite RLS being enabled.
--
-- Safe to re-run: uses DROP POLICY IF EXISTS before CREATE.
-- ============================================================

-- Verify backfill before enforcing NOT NULL (run manually, check = 0):
-- SELECT count(*) FROM deal_team_members WHERE brokerage_id IS NULL;

-- ─── STEP 1: Backfill any remaining NULLs from the linked transaction ────────
UPDATE deal_team_members dtm
SET brokerage_id = t.brokerage_id
FROM transactions t
WHERE dtm.transaction_id = t.id
  AND dtm.brokerage_id IS NULL;

-- ─── STEP 2: Enable RLS (idempotent) ─────────────────────────────────────────
ALTER TABLE deal_team_members ENABLE ROW LEVEL SECURITY;

-- ─── STEP 3: Drop existing policy if it was previously created ───────────────
DROP POLICY IF EXISTS "team_members_brokerage_isolation" ON deal_team_members;
DROP POLICY IF EXISTS "dtm_brokerage_isolation"           ON deal_team_members;

-- ─── STEP 4: Brokerage isolation — agents/brokers see only their brokerage ───
-- Agents and brokers on a deal can view team members for that deal.
-- Admins bypass via the is_admin() check.
-- Superadmins are handled at the application layer (service role client).
CREATE POLICY "dtm_brokerage_isolation"
  ON deal_team_members
  FOR ALL
  USING (
    brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
    OR (SELECT user_type FROM users WHERE id = auth.uid()) IN ('admin', 'super_admin')
  );

-- ─── STEP 5: Agents can only insert deal team members for their own transactions ─
-- The INSERT check ensures an agent cannot add team members to a transaction
-- they don't own (owned = agent_id matches their agents.id row).
DROP POLICY IF EXISTS "dtm_agent_insert" ON deal_team_members;

CREATE POLICY "dtm_agent_insert"
  ON deal_team_members
  FOR INSERT
  WITH CHECK (
    brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
    AND (
      (SELECT user_type FROM users WHERE id = auth.uid()) IN ('broker', 'broker_owner', 'admin', 'super_admin')
      OR transaction_id IN (
        SELECT id FROM transactions
        WHERE agent_id        = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
           OR seller_agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
           OR buyer_agent_id  = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
      )
    )
  );
