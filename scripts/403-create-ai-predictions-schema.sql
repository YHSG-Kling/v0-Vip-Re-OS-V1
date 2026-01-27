-- =====================================================
-- AI Predictions & Intelligence Schema
-- Creates tables for AI-powered predictions, insights,
-- lead scoring, CMAs, and conversation intelligence
-- =====================================================

-- First ensure the leads table exists (if not, create it as alias for contacts)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leads') THEN
    -- Create leads as a view of contacts for compatibility
    CREATE VIEW leads AS SELECT * FROM contacts;
  END IF;
END $$;

-- =====================================================
-- AI Predictions & Forecasting
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_type TEXT NOT NULL, -- 'lead_conversion', 'deal_close_probability', 'price_reduction', 'days_to_sell', 'buyer_offer_amount', 'negotiation_outcome'
  entity_type TEXT NOT NULL, -- 'lead', 'transaction', 'property', 'agent'
  entity_id UUID NOT NULL,
  
  -- Prediction
  prediction_value JSONB NOT NULL,
  confidence_score DECIMAL(3,2) NOT NULL, -- 0.00-1.00
  prediction_factors JSONB, -- What influenced this prediction
  
  -- Validation
  predicted_at TIMESTAMPTZ DEFAULT NOW(),
  outcome_date TIMESTAMPTZ,
  actual_outcome JSONB,
  prediction_accuracy DECIMAL(5,2), -- Calculated after outcome known
  
  -- Model Info
  model_version TEXT,
  training_data_size INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- AI-Generated Insights
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_type TEXT NOT NULL, -- 'opportunity', 'risk', 'recommendation', 'pattern', 'anomaly'
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  
  -- Insight
  insight_title TEXT NOT NULL,
  insight_description TEXT NOT NULL,
  insight_data JSONB,
  actionable_steps TEXT[],
  priority TEXT, -- 'critical', 'high', 'medium', 'low'
  
  -- Impact
  estimated_impact JSONB, -- {revenue: +$50000, time_saved: '10 hours', probability: 0.85}
  
  -- Status
  status TEXT DEFAULT 'new', -- 'new', 'viewed', 'acted_on', 'dismissed'
  acted_on_at TIMESTAMPTZ,
  outcome TEXT,
  
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- =====================================================
-- Predictive Lead Scoring (ML-Based)
-- =====================================================
CREATE TABLE IF NOT EXISTS predictive_lead_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  
  -- Conversion Prediction
  conversion_probability DECIMAL(5,2), -- 0-100%
  predicted_conversion_date DATE,
  predicted_deal_size DECIMAL(12,2),
  predicted_timeline_days INTEGER,
  
  -- Scoring Components
  behavioral_score INTEGER, -- Based on engagement patterns
  demographic_score INTEGER, -- Based on people data
  property_ownership_score INTEGER, -- Based on equity, ownership length
  market_timing_score INTEGER, -- Based on market conditions
  financial_readiness_score INTEGER, -- Based on income, credit indicators
  urgency_score INTEGER, -- Based on timeline signals
  
  -- Overall
  overall_ai_score INTEGER, -- 0-100 composite score
  score_tier TEXT, -- 'platinum', 'gold', 'silver', 'bronze'
  
  -- Recommendations
  recommended_actions JSONB,
  optimal_contact_time TIMESTAMPTZ,
  best_communication_channel TEXT,
  personalized_approach TEXT,
  
  -- Model
  last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  model_version TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT unique_lead_score UNIQUE (lead_id)
);

-- =====================================================
-- Auto-Generated CMAs (State Compliant)
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_generated_cmas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  property_address TEXT NOT NULL,
  generated_for TEXT NOT NULL, -- 'seller', 'buyer', 'listing'
  
  -- Property Valuation
  estimated_value DECIMAL(12,2) NOT NULL,
  value_range_low DECIMAL(12,2),
  value_range_high DECIMAL(12,2),
  confidence_level TEXT, -- 'high', 'medium', 'low'
  
  -- Comparable Properties (from IDX Broker)
  comparable_properties JSONB NOT NULL,
  comparables_methodology TEXT,
  adjustments JSONB, -- Price adjustments made for differences
  
  -- Market Analysis
  market_trends JSONB,
  days_on_market_estimate INTEGER,
  optimal_list_price DECIMAL(12,2),
  price_reduction_probability DECIMAL(5,2),
  
  -- State Compliance
  state TEXT NOT NULL,
  appraiser_guidelines_used TEXT, -- Which state guidelines
  compliance_disclaimers TEXT[],
  licensed_appraiser_reviewed BOOLEAN DEFAULT false,
  
  -- Presentation
  cma_pdf_url TEXT,
  interactive_dashboard_url TEXT,
  
  -- Usage
  shared_with_client BOOLEAN DEFAULT false,
  shared_at TIMESTAMPTZ,
  client_viewed BOOLEAN DEFAULT false,
  
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- Smart Showing Recommendations
-- =====================================================
CREATE TABLE IF NOT EXISTS smart_showing_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  
  -- AI-Selected Properties
  recommended_properties JSONB NOT NULL, -- Top matches with reasoning
  property_clusters JSONB, -- Group by neighborhood for efficient touring
  
  -- Optimal Route
  showing_route JSONB, -- Optimized route to see multiple properties
  total_drive_time INTEGER, -- minutes
  suggested_order TEXT[],
  
  -- Timing
  recommended_day TEXT,
  recommended_time TEXT,
  avoid_times TEXT[], -- Based on traffic, client schedule
  
  -- Personalization
  why_these_properties TEXT,
  match_reasoning JSONB,
  
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- =====================================================
-- Predictive Market Alerts
-- =====================================================
CREATE TABLE IF NOT EXISTS predictive_market_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL, -- 'price_drop_incoming', 'hot_property', 'neighborhood_trending', 'inventory_shortage', 'buyer_opportunity'
  market_area TEXT NOT NULL,
  
  -- Prediction
  prediction TEXT NOT NULL,
  confidence DECIMAL(3,2),
  predicted_timeframe TEXT,
  
  -- Impact
  affected_leads UUID[],
  affected_listings UUID[],
  opportunity_type TEXT,
  estimated_value DECIMAL(12,2),
  
  -- AI Reasoning
  factors JSONB,
  data_sources TEXT[],
  
  -- Action
  recommended_actions JSONB,
  urgency TEXT,
  
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- =====================================================
-- Conversation Intelligence (AI Call/Message Analysis)
-- =====================================================
CREATE TABLE IF NOT EXISTS conversation_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  agent_id UUID,
  conversation_type TEXT NOT NULL, -- 'call', 'sms', 'email', 'chat'
  conversation_id TEXT,
  
  -- AI Analysis
  transcript TEXT,
  summary TEXT,
  key_points TEXT[],
  sentiment_score DECIMAL(3,2), -- -1.00 to 1.00
  intent_detected TEXT[],
  objections_raised TEXT[],
  buying_signals TEXT[],
  pain_points TEXT[],
  
  -- Coaching
  them_first_score INTEGER,
  coaching_suggestions TEXT[],
  missed_opportunities TEXT[],
  
  -- Next Steps
  ai_recommended_followup TEXT,
  optimal_followup_time TIMESTAMPTZ,
  
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- AI Agent Coach (Continuous Learning)
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_agent_coaching (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  
  -- Performance Pattern Analysis
  strengths TEXT[],
  weaknesses TEXT[],
  improvement_areas TEXT[],
  
  -- Personalized Training
  recommended_training JSONB,
  skill_gaps TEXT[],
  next_certification TEXT,
  
  -- Behavioral Patterns
  best_performing_times JSONB, -- When agent closes most deals
  most_effective_communication_style TEXT,
  ideal_lead_profile JSONB,
  
  -- Them-First Coaching
  them_first_trends JSONB, -- Improving or declining?
  common_mistakes TEXT[],
  success_patterns TEXT[],
  
  last_analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT unique_agent_coaching UNIQUE (agent_id)
);

-- =====================================================
-- Automated Price Recommendations
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_pricing_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_address TEXT NOT NULL,
  lead_id UUID,
  transaction_id UUID,
  
  -- AI Recommendation
  recommended_list_price DECIMAL(12,2) NOT NULL,
  price_range_min DECIMAL(12,2),
  price_range_max DECIMAL(12,2),
  
  -- Reasoning
  factors JSONB, -- Market conditions, comp analysis, timing
  comparable_sales JSONB,
  market_position_analysis TEXT,
  
  -- Predictions
  predicted_days_to_sell INTEGER,
  predicted_final_sale_price DECIMAL(12,2),
  probability_of_price_reduction DECIMAL(5,2),
  optimal_timing TEXT, -- 'list_now', 'wait_2_weeks', 'wait_for_spring'
  
  -- Dynamic Pricing Strategy
  pricing_strategy TEXT, -- 'price_high_negotiate', 'price_competitive', 'price_low_bidding_war'
  adjustment_triggers JSONB, -- When to reduce price automatically
  
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- Create Indexes for Performance
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_ai_predictions_entity ON ai_predictions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_type ON ai_predictions(prediction_type);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_predicted_at ON ai_predictions(predicted_at);

CREATE INDEX IF NOT EXISTS idx_ai_insights_entity ON ai_insights(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_status ON ai_insights(status);
CREATE INDEX IF NOT EXISTS idx_ai_insights_priority ON ai_insights(priority);

CREATE INDEX IF NOT EXISTS idx_predictive_scores_lead ON predictive_lead_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_predictive_scores_tier ON predictive_lead_scores(score_tier);
CREATE INDEX IF NOT EXISTS idx_predictive_scores_overall ON predictive_lead_scores(overall_ai_score);

CREATE INDEX IF NOT EXISTS idx_ai_cmas_lead ON ai_generated_cmas(lead_id);
CREATE INDEX IF NOT EXISTS idx_ai_cmas_state ON ai_generated_cmas(state);

CREATE INDEX IF NOT EXISTS idx_showing_recommendations_lead ON smart_showing_recommendations(lead_id);

CREATE INDEX IF NOT EXISTS idx_market_alerts_type ON predictive_market_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_market_alerts_area ON predictive_market_alerts(market_area);

CREATE INDEX IF NOT EXISTS idx_conversation_intelligence_lead ON conversation_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_conversation_intelligence_agent ON conversation_intelligence(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversation_intelligence_analyzed ON conversation_intelligence(analyzed_at);

CREATE INDEX IF NOT EXISTS idx_agent_coaching_agent ON ai_agent_coaching(agent_id);

CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_lead ON ai_pricing_recommendations(lead_id);
CREATE INDEX IF NOT EXISTS idx_pricing_recommendations_transaction ON ai_pricing_recommendations(transaction_id);

-- =====================================================
-- Enable Row Level Security
-- =====================================================
ALTER TABLE ai_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictive_lead_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_generated_cmas ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_showing_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictive_market_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_coaching ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_pricing_recommendations ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- Create RLS Policies (permissive for authenticated users)
-- =====================================================
DROP POLICY IF EXISTS "ai_predictions_all" ON ai_predictions;
DROP POLICY IF EXISTS "ai_insights_all" ON ai_insights;
DROP POLICY IF EXISTS "predictive_lead_scores_all" ON predictive_lead_scores;
DROP POLICY IF EXISTS "ai_generated_cmas_all" ON ai_generated_cmas;
DROP POLICY IF EXISTS "smart_showing_recommendations_all" ON smart_showing_recommendations;
DROP POLICY IF EXISTS "predictive_market_alerts_all" ON predictive_market_alerts;
DROP POLICY IF EXISTS "conversation_intelligence_all" ON conversation_intelligence;
DROP POLICY IF EXISTS "ai_agent_coaching_all" ON ai_agent_coaching;
DROP POLICY IF EXISTS "ai_pricing_recommendations_all" ON ai_pricing_recommendations;

CREATE POLICY "ai_predictions_all" ON ai_predictions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "ai_insights_all" ON ai_insights FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "predictive_lead_scores_all" ON predictive_lead_scores FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "ai_generated_cmas_all" ON ai_generated_cmas FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "smart_showing_recommendations_all" ON smart_showing_recommendations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "predictive_market_alerts_all" ON predictive_market_alerts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "conversation_intelligence_all" ON conversation_intelligence FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "ai_agent_coaching_all" ON ai_agent_coaching FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "ai_pricing_recommendations_all" ON ai_pricing_recommendations FOR ALL TO authenticated USING (true) WITH CHECK (true);
