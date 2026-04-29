-- Pass 9 leftover: create marketing_campaigns table referenced by app/actions/marketing-campaigns.ts
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id),
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL CHECK (campaign_type IN ('email','sms','direct_mail','ad','social','multi')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  visibility_scope TEXT DEFAULT 'agent' CHECK (visibility_scope IN ('agent','brokerage','team')),
  budget_total NUMERIC(12,2),
  budget_spent NUMERIC(12,2) DEFAULT 0,
  target_audience JSONB DEFAULT '{}',
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  launched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_agent ON marketing_campaigns(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_brokerage ON marketing_campaigns(brokerage_id);

ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can manage own campaigns" ON marketing_campaigns
  FOR ALL USING (agent_user_id = auth.uid() OR created_by = auth.uid());

CREATE POLICY "Brokers can manage brokerage campaigns" ON marketing_campaigns
  FOR ALL USING (
    brokerage_id IN (
      SELECT brokerage_id FROM user_role_assignments
      WHERE user_id = auth.uid() AND role IN ('broker','admin','superadmin')
    )
  );
