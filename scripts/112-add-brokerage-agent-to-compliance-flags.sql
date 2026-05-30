-- Migration 112: Add brokerage_id and agent_id to compliance_flags
-- The compliance_flags table is used by the compliance flags route which filters
-- by brokerage_id and agent_id from the authenticated session. The table currently
-- has no brokerage_id or agent_id column, so we add them here.
-- Existing rows get NULL for both columns (they predate this schema addition).

ALTER TABLE compliance_flags
  ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS agent_id     UUID REFERENCES agents(id)     ON DELETE SET NULL;

-- Index for brokerage-scoped lookups
CREATE INDEX IF NOT EXISTS compliance_flags_brokerage_id_idx ON compliance_flags(brokerage_id);
CREATE INDEX IF NOT EXISTS compliance_flags_agent_id_idx     ON compliance_flags(agent_id);

-- Enable RLS properly (it was already enabled but had 0 broker/agent-scoped policies)
-- Drop the single existing INSERT policy and replace with full brokerage-scoped policies
DROP POLICY IF EXISTS "Users can insert compliance flags" ON compliance_flags;

-- Agents can insert their own flags
CREATE POLICY "agent_insert_compliance_flags"
  ON compliance_flags FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1)
  );

-- Agents see only their own flags; brokers/admins/compliance see all in brokerage
CREATE POLICY "agent_read_own_compliance_flags"
  ON compliance_flags FOR SELECT
  USING (
    brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1)
    AND (
      (SELECT user_type FROM users WHERE id = auth.uid() LIMIT 1) IN ('broker', 'admin', 'superadmin', 'compliance_officer')
      OR agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
      OR user_id = auth.uid()
    )
  );

-- Brokers and compliance can update flags (e.g., resolve them)
CREATE POLICY "broker_update_compliance_flags"
  ON compliance_flags FOR UPDATE
  USING (
    brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1)
    AND (SELECT user_type FROM users WHERE id = auth.uid() LIMIT 1) IN ('broker', 'admin', 'superadmin', 'compliance_officer')
  );
