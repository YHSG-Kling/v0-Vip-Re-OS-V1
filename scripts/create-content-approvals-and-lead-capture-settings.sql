-- SM3: Create content_approvals table (used by lib/content-guardian for Fair Housing violations)
CREATE TABLE IF NOT EXISTS content_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id),
  content_type TEXT NOT NULL,
  original_content TEXT NOT NULL,
  sanitized_content TEXT,
  violations JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE content_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agents_own_approvals_select" ON content_approvals
  FOR SELECT USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );

CREATE POLICY "agents_own_approvals_insert" ON content_approvals
  FOR INSERT WITH CHECK (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );

CREATE POLICY "brokers_view_brokerage_approvals" ON content_approvals
  FOR SELECT USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users
      WHERE id = auth.uid()
        AND user_type IN ('broker', 'admin')
    )
  );

CREATE POLICY "brokers_admins_update_approvals" ON content_approvals
  FOR UPDATE USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users
      WHERE id = auth.uid()
        AND user_type IN ('broker', 'admin')
    )
  );

-- SM4: Add settings column to lead_capture_forms (used by notify_on_submission toggle)
ALTER TABLE lead_capture_forms
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';
