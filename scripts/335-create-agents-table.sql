-- ============================================================================
-- AGENTS TABLE - Extends users table with agent-specific data
-- ============================================================================
-- This table stores agent-specific information for tracking:
-- - Gamification (points, badges, achievements, leaderboard)
-- - Commission tracking and cap progress
-- - Expenses and P&L
-- - Performance metrics
-- - Service areas and specialties

-- Create agents table
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID,
  
  -- Basic Info
  license_number TEXT,
  license_state TEXT,
  license_expiry DATE,
  nrds_id TEXT,
  mls_id TEXT,
  
  -- Team Structure
  team_id UUID,
  team_lead_id UUID,
  mentor_id UUID,
  
  -- Service Areas
  service_areas_zips TEXT[],
  service_areas_cities TEXT[],
  specialties TEXT[], -- Luxury, First-Time, Investor, Relocation, etc.
  
  -- Performance Metrics (YTD)
  ytd_volume DECIMAL(15,2) DEFAULT 0,
  ytd_units INTEGER DEFAULT 0,
  ytd_gci DECIMAL(12,2) DEFAULT 0,
  closing_rate DECIMAL(5,2) DEFAULT 0,
  avg_days_on_market INTEGER DEFAULT 0,
  list_to_sale_ratio DECIMAL(5,2) DEFAULT 0,
  
  -- Cap Tracking
  cap_amount DECIMAL(10,2) DEFAULT 20000,
  cap_paid DECIMAL(10,2) DEFAULT 0,
  cap_reached_date DATE,
  cap_anniversary_date DATE,
  
  -- Commission Structure
  commission_split DECIMAL(5,2) DEFAULT 70, -- Agent's percentage
  commission_tier TEXT DEFAULT 'standard', -- standard, senior, elite
  
  -- Gamification
  total_points INTEGER DEFAULT 0,
  current_level INTEGER DEFAULT 1,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  badges JSONB DEFAULT '[]'::jsonb,
  achievements JSONB DEFAULT '[]'::jsonb,
  leaderboard_rank INTEGER,
  
  -- Lead Routing
  daily_lead_cap INTEGER DEFAULT 5,
  leads_received_today INTEGER DEFAULT 0,
  lead_response_time_avg INTEGER, -- in minutes
  lead_acceptance_rate DECIMAL(5,2),
  
  -- Availability
  availability_status TEXT DEFAULT 'available', -- available, busy, offline, vacation
  vacation_start DATE,
  vacation_end DATE,
  
  -- Digital Identity (HeyGen)
  heygen_avatar_id TEXT,
  heygen_voice_id TEXT,
  default_video_background_type TEXT,
  default_video_background_value TEXT,
  
  -- Onboarding
  onboarding_completed BOOLEAN DEFAULT false,
  onboarding_checklist JSONB DEFAULT '{}'::jsonb,
  hire_date DATE,
  
  -- Settings
  notification_preferences JSONB DEFAULT '{}'::jsonb,
  settings JSONB DEFAULT '{}'::jsonb,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_brokerage_id ON agents(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_agents_team_id ON agents(team_id);
CREATE INDEX IF NOT EXISTS idx_agents_availability ON agents(availability_status);
CREATE INDEX IF NOT EXISTS idx_agents_leaderboard ON agents(leaderboard_rank);
CREATE INDEX IF NOT EXISTS idx_agents_license_state ON agents(license_state);

-- Enable RLS
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Service role manages agents" ON agents;
CREATE POLICY "Service role manages agents" ON agents
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- AGENT GAMIFICATION TABLES
-- ============================================================================

-- Agent Points History
CREATE TABLE IF NOT EXISTS agent_points_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  action_type TEXT NOT NULL, -- listing_created, deal_closed, lead_converted, showing_completed, review_received, etc.
  description TEXT,
  reference_id UUID, -- ID of the related entity (transaction, contact, etc.)
  reference_type TEXT, -- transaction, contact, listing, etc.
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_points_agent_id ON agent_points_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_points_created_at ON agent_points_history(created_at);

ALTER TABLE agent_points_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages agent points" ON agent_points_history;
CREATE POLICY "Service role manages agent points" ON agent_points_history
  FOR ALL USING (true) WITH CHECK (true);

-- Agent Badges
CREATE TABLE IF NOT EXISTS agent_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  points_required INTEGER,
  criteria JSONB, -- Flexible criteria for earning badge
  tier TEXT DEFAULT 'bronze', -- bronze, silver, gold, platinum
  category TEXT, -- performance, milestone, special, seasonal
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default badges
INSERT INTO agent_badges (name, description, icon, points_required, tier, category) VALUES
  ('Fast Starter', 'Close your first deal within 90 days', 'rocket', 100, 'bronze', 'milestone'),
  ('Top Closer', 'Close 10+ deals in a year', 'trophy', 500, 'gold', 'performance'),
  ('Five Star', 'Receive 5 five-star reviews', 'star', 250, 'silver', 'performance'),
  ('Volume Titan', 'Exceed $10M in annual volume', 'trending-up', 1000, 'platinum', 'performance'),
  ('Lead Machine', 'Convert 50+ leads', 'users', 300, 'silver', 'performance'),
  ('Speed Demon', 'Average response time under 5 minutes', 'zap', 200, 'bronze', 'performance'),
  ('Mentor', 'Help onboard 3 new agents', 'heart', 400, 'gold', 'special'),
  ('Legend', 'Reach Level 10', 'crown', 2000, 'platinum', 'milestone')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE agent_badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages agent badges" ON agent_badges;
CREATE POLICY "Service role manages agent badges" ON agent_badges
  FOR ALL USING (true) WITH CHECK (true);

-- Agent Earned Badges
CREATE TABLE IF NOT EXISTS agent_earned_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  badge_id UUID REFERENCES agent_badges(id) ON DELETE CASCADE,
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_earned_badges_agent_id ON agent_earned_badges(agent_id);

ALTER TABLE agent_earned_badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages earned badges" ON agent_earned_badges;
CREATE POLICY "Service role manages earned badges" ON agent_earned_badges
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- AGENT COMMISSION & EXPENSES TABLES
-- ============================================================================

-- Agent Commission Records
CREATE TABLE IF NOT EXISTS agent_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  transaction_id UUID,
  property_address TEXT,
  close_date DATE,
  sale_price DECIMAL(15,2),
  commission_rate DECIMAL(5,4), -- e.g., 0.03 for 3%
  gross_commission DECIMAL(12,2),
  split_percentage DECIMAL(5,2),
  agent_share DECIMAL(12,2),
  brokerage_share DECIMAL(12,2),
  referral_fee DECIMAL(12,2) DEFAULT 0,
  franchise_fee DECIMAL(12,2) DEFAULT 0,
  net_to_agent DECIMAL(12,2),
  applies_to_cap BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'pending', -- pending, paid, disputed
  paid_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_commissions_agent_id ON agent_commissions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_close_date ON agent_commissions(close_date);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_status ON agent_commissions(status);

ALTER TABLE agent_commissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages agent commissions" ON agent_commissions;
CREATE POLICY "Service role manages agent commissions" ON agent_commissions
  FOR ALL USING (true) WITH CHECK (true);

-- Agent Expenses
CREATE TABLE IF NOT EXISTS agent_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  transaction_id UUID,
  expense_type TEXT NOT NULL, -- marketing, mls_dues, e&o_insurance, desk_fee, tech_fee, continuing_ed, etc.
  description TEXT,
  amount DECIMAL(10,2) NOT NULL,
  vendor TEXT,
  receipt_url TEXT,
  expense_date DATE DEFAULT CURRENT_DATE,
  is_recurring BOOLEAN DEFAULT false,
  recurring_frequency TEXT, -- monthly, quarterly, annually
  tax_deductible BOOLEAN DEFAULT true,
  reimbursable BOOLEAN DEFAULT false,
  reimbursed BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected, paid
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_expenses_agent_id ON agent_expenses(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_expenses_type ON agent_expenses(expense_type);
CREATE INDEX IF NOT EXISTS idx_agent_expenses_date ON agent_expenses(expense_date);

ALTER TABLE agent_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages agent expenses" ON agent_expenses;
CREATE POLICY "Service role manages agent expenses" ON agent_expenses
  FOR ALL USING (true) WITH CHECK (true);

-- Agent Goals
CREATE TABLE IF NOT EXISTS agent_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  goal_type TEXT NOT NULL, -- volume, units, gci, leads, listings
  target_value DECIMAL(15,2) NOT NULL,
  current_value DECIMAL(15,2) DEFAULT 0,
  period_type TEXT DEFAULT 'yearly', -- monthly, quarterly, yearly
  period_start DATE,
  period_end DATE,
  status TEXT DEFAULT 'in_progress', -- in_progress, achieved, missed
  achieved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_goals_agent_id ON agent_goals(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_goals_period ON agent_goals(period_start, period_end);

ALTER TABLE agent_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages agent goals" ON agent_goals;
CREATE POLICY "Service role manages agent goals" ON agent_goals
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- UPDATE CONTACTS TABLE TO REFERENCE AGENTS
-- ============================================================================

-- Add agent_id to contacts if not exists (references agents table)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'contacts' AND column_name = 'assigned_agent_id'
  ) THEN
    ALTER TABLE contacts ADD COLUMN assigned_agent_id UUID REFERENCES agents(id);
    CREATE INDEX IF NOT EXISTS idx_contacts_assigned_agent ON contacts(assigned_agent_id);
  END IF;
END $$;

-- ============================================================================
-- SEED DEMO AGENTS (link to existing users)
-- ============================================================================

-- This will be populated when users with user_type='agent' are created
-- The AgentRoster page will create agents records as needed
