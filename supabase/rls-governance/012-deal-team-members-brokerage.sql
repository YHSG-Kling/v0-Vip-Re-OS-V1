-- =====================================================
-- MIGRATION 012: Add brokerage_id to deal_team_members
-- =====================================================
-- deal_team_members had no brokerage_id, so it was impossible to
-- apply brokerage isolation via RLS. This migration adds the column,
-- backfills it from the parent transaction, and adds the RLS policy.
-- =====================================================

ALTER TABLE deal_team_members
  ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id);

UPDATE deal_team_members dtm
SET brokerage_id = t.brokerage_id
FROM transactions t
WHERE dtm.transaction_id = t.id
  AND dtm.brokerage_id IS NULL;

DROP POLICY IF EXISTS "team_members_brokerage_isolation" ON deal_team_members;

CREATE POLICY "team_members_brokerage_isolation"
  ON deal_team_members FOR ALL
  USING (brokerage_id = auth.user_brokerage_id());
