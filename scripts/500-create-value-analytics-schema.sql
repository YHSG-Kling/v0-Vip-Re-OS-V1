-- Value-Driven Analytics Schema
-- Tracks value delivered, trust capital, and relationship health

-- 1. VALUE METRICS - Daily value tracking
CREATE TABLE IF NOT EXISTS value_delivered_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  agent_id UUID REFERENCES agents(id),
  
  -- Value activities
  free_tools_used_count INT DEFAULT 0,
  guides_downloaded_count INT DEFAULT 0,
  community_members_added INT DEFAULT 0,
  questions_answered_count INT DEFAULT 0,
  introductions_made INT DEFAULT 0,
  personalized_reports_sent INT DEFAULT 0,
  
  -- Value calculation
  total_value_delivered_dollars DECIMAL(10,2) DEFAULT 0,
  cost_to_deliver DECIMAL(10,2) DEFAULT 0,
  recipients_count INT DEFAULT 0,
  conversion_events INT DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, agent_id)
);

-- 2. HOLISTIC PERFORMANCE - Traditional + Value metrics
CREATE TABLE IF NOT EXISTS agent_performance_holistic (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  
  -- Traditional metrics
  traditional_metrics_json JSONB DEFAULT '{}'::jsonb,
  -- { gci, units_closed, calls_made, showings_held }
  
  -- Value metrics
  value_metrics_json JSONB DEFAULT '{}'::jsonb,
  -- { tools_used, guides_shared, help_given, reports_sent }
  
  -- Relationship metrics
  relationship_metrics_json JSONB DEFAULT '{}'::jsonb,
  -- { nps_score, referrals, repeat_rate, satisfaction }
  
  -- Community metrics
  community_metrics_json JSONB DEFAULT '{}'::jsonb,
  -- { engagement_rate, contributions, questions_answered }
  
  -- Calculated scores
  trust_capital_score INT DEFAULT 0 CHECK (trust_capital_score >= 0 AND trust_capital_score <= 100),
  generosity_score INT DEFAULT 0 CHECK (generosity_score >= 0 AND generosity_score <= 100),
  reciprocity_rate_percent DECIMAL(5,2) DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. LEAD VALUE JOURNEY - Track value received before conversion
CREATE TABLE IF NOT EXISTS lead_value_journey (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Journey tracking
  first_interaction_date DATE,
  total_value_received DECIMAL(10,2) DEFAULT 0,
  touchpoints_count INT DEFAULT 0,
  
  -- Value activities
  tools_used TEXT[] DEFAULT '{}',
  guides_downloaded TEXT[] DEFAULT '{}',
  community_engagement_score INT DEFAULT 0,
  
  -- Conversion tracking
  time_to_conversion_days INT,
  conversion_value DECIMAL(10,2),
  roi_multiple DECIMAL(5,2),
  became_client BOOLEAN DEFAULT FALSE,
  became_referrer BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. COMMUNITY HEALTH - Daily community metrics
CREATE TABLE IF NOT EXISTS community_health_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  
  -- Member metrics
  total_members INT DEFAULT 0,
  active_members_7d INT DEFAULT 0,
  engagement_rate DECIMAL(5,2) DEFAULT 0,
  
  -- Content metrics
  content_shared_count INT DEFAULT 0,
  questions_asked INT DEFAULT 0,
  questions_answered INT DEFAULT 0,
  
  -- Health indicators
  member_satisfaction_score INT DEFAULT 0,
  churn_rate DECIMAL(5,2) DEFAULT 0,
  growth_rate DECIMAL(5,2) DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. AI COACHING - Daily insights
CREATE TABLE IF NOT EXISTS ai_coaching_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  insight_date DATE NOT NULL,
  
  -- Insight content
  insight_text TEXT NOT NULL,
  insight_category TEXT CHECK (insight_category IN ('motivational', 'corrective', 'strategic', 'tactical')),
  based_on_metrics_json JSONB DEFAULT '{}'::jsonb,
  action_recommended TEXT,
  
  -- Agent interaction
  agent_acknowledged BOOLEAN DEFAULT FALSE,
  agent_feedback TEXT,
  effectiveness_score INT CHECK (effectiveness_score >= 0 AND effectiveness_score <= 10),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. PERFORMANCE PATTERNS - AI-detected patterns
CREATE TABLE IF NOT EXISTS performance_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  
  -- Pattern details
  pattern_type TEXT CHECK (pattern_type IN ('strength', 'weakness', 'opportunity', 'threat')),
  pattern_description TEXT NOT NULL,
  detected_date DATE NOT NULL,
  recommendation TEXT,
  
  -- Implementation tracking
  implemented BOOLEAN DEFAULT FALSE,
  implemented_date DATE,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. PERFORMANCE ALERTS - Threshold-based notifications
CREATE TABLE IF NOT EXISTS performance_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  
  -- Alert details
  alert_type TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  threshold_value DECIMAL(10,2),
  current_value DECIMAL(10,2),
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Severity and resolution
  severity TEXT CHECK (severity IN ('info', 'warning', 'critical')),
  resolved BOOLEAN DEFAULT FALSE,
  action_taken TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. GOALS - Agent performance goals
CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  
  -- Goal details
  goal_type TEXT CHECK (goal_type IN ('revenue', 'units', 'value_delivered', 'community_growth', 'satisfaction')),
  target_value DECIMAL(10,2) NOT NULL,
  current_value DECIMAL(10,2) DEFAULT 0,
  period TEXT CHECK (period IN ('monthly', 'quarterly', 'annual')),
  
  -- Progress tracking
  progress_percent DECIMAL(5,2) DEFAULT 0,
  on_track BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_value_delivered_agent_date ON value_delivered_daily(agent_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_performance_agent_period ON agent_performance_holistic(agent_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_lead_journey_contact ON lead_value_journey(contact_id);
CREATE INDEX IF NOT EXISTS idx_ai_coaching_agent_date ON ai_coaching_daily(agent_id, insight_date DESC);
CREATE INDEX IF NOT EXISTS idx_performance_patterns_agent ON performance_patterns(agent_id, detected_date DESC);
CREATE INDEX IF NOT EXISTS idx_performance_alerts_agent ON performance_alerts(agent_id, resolved, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_agent ON goals(agent_id, period);

COMMIT;
