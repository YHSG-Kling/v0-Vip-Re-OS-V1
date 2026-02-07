-- =====================================================
-- SYSTEM 3.4: CONVERSATION INTELLIGENCE & ESCALATION SIGNAL ENGINE
-- =====================================================
-- This system is READ-ONLY with respect to conversations.
-- It produces ANALYTICAL SIGNALS ONLY.
-- Dependencies: System 3.1 (Unified Communication Spine), System 3.2 (AI ISA), System 3.3 (Voice Engine)

BEGIN;

-- =====================================================
-- CONVERSATION INSIGHTS TABLE
-- =====================================================
-- Stores analytical signals derived from conversations
-- This table is WRITE-ONLY for this system, READ-ONLY for orchestration
CREATE TABLE IF NOT EXISTS conversation_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES users(id),
  
  -- Sentiment Analysis
  sentiment_score NUMERIC CHECK (sentiment_score >= -1 AND sentiment_score <= 1), -- -1 (negative) to 1 (positive)
  sentiment_label TEXT CHECK (sentiment_label IN ('frustrated', 'confused', 'neutral', 'satisfied', 'excited')),
  sentiment_trend TEXT CHECK (sentiment_trend IN ('improving', 'declining', 'stable', 'volatile')),
  sentiment_confidence NUMERIC CHECK (sentiment_confidence >= 0 AND sentiment_confidence <= 1),
  
  -- Conversation Health
  health_score NUMERIC CHECK (health_score >= 0 AND health_score <= 100),
  health_factors JSONB DEFAULT '{}'::jsonb, -- Details: response_latency, unanswered_count, balance_ratio, etc.
  last_agent_response_at TIMESTAMPTZ,
  last_contact_response_at TIMESTAMPTZ,
  unanswered_messages_count INTEGER DEFAULT 0,
  avg_response_time_minutes NUMERIC,
  message_balance_ratio NUMERIC, -- agent_messages / contact_messages
  
  -- Escalation Signals
  escalation_recommended BOOLEAN DEFAULT false,
  escalation_urgency TEXT CHECK (escalation_urgency IN ('low', 'medium', 'high', 'critical')),
  escalation_reason TEXT,
  escalation_target TEXT CHECK (escalation_target IN ('assigned_agent', 'office_support', 'brokerage_admin', 'compliance_officer')),
  escalation_context JSONB DEFAULT '{}'::jsonb, -- Additional context for escalation decision
  
  -- AI ISA Validation
  ai_isa_confidence NUMERIC, -- Original AI ISA confidence score
  ai_isa_validation_result TEXT CHECK (ai_isa_validation_result IN ('confirmed', 'mismatch', 'needs_review', 'unknown')),
  ai_isa_discrepancy_details TEXT,
  ai_isa_correction_signal JSONB DEFAULT '{}'::jsonb, -- Suggested corrections
  
  -- Voice Intelligence
  voice_call_analyzed BOOLEAN DEFAULT false,
  voice_interruption_count INTEGER,
  voice_silence_duration_seconds INTEGER,
  voice_call_quality_score NUMERIC CHECK (voice_call_quality_score >= 0 AND voice_call_quality_score <= 10),
  voice_transcript_analyzed BOOLEAN DEFAULT false,
  
  -- Urgency Detection
  urgency_detected BOOLEAN DEFAULT false,
  urgency_signals JSONB DEFAULT '[]'::jsonb, -- List of urgency indicators
  urgency_keywords TEXT[], -- Keywords that triggered urgency detection
  
  -- Metadata
  analysis_timestamp TIMESTAMPTZ DEFAULT now(),
  analysis_version TEXT DEFAULT '1.0', -- For tracking algorithm versions
  confidence_overall NUMERIC CHECK (confidence_overall >= 0 AND confidence_overall <= 1),
  metadata JSONB DEFAULT '{}'::jsonb, -- Extensible field for additional signals
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_conversation_insights_conversation ON conversation_insights(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_contact ON conversation_insights(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_agent ON conversation_insights(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_escalation ON conversation_insights(escalation_recommended, escalation_urgency);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_health ON conversation_insights(health_score);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_sentiment ON conversation_insights(sentiment_label, sentiment_score);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_timestamp ON conversation_insights(analysis_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_ai_validation ON conversation_insights(ai_isa_validation_result);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================
ALTER TABLE conversation_insights ENABLE ROW LEVEL SECURITY;

-- Agents can view insights for their conversations
CREATE POLICY conversation_insights_agent_view ON conversation_insights
  FOR SELECT
  USING (
    agent_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker', 'compliance_officer')
    )
  );

-- System can insert insights (service_role only)
CREATE POLICY conversation_insights_system_insert ON conversation_insights
  FOR INSERT
  WITH CHECK (true); -- Service role can insert

-- System can update insights (service_role only)
CREATE POLICY conversation_insights_system_update ON conversation_insights
  FOR UPDATE
  USING (true); -- Service role can update

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_conversation_insights_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_insights_updated_at_trigger
  BEFORE UPDATE ON conversation_insights
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_insights_timestamp();

-- =====================================================
-- VIEWS FOR ANALYTICS
-- =====================================================

-- High-priority escalations view
CREATE OR REPLACE VIEW escalation_signals_urgent AS
SELECT 
  ci.id,
  ci.conversation_id,
  ci.contact_id,
  ci.agent_id,
  c.first_name || ' ' || c.last_name AS contact_name,
  u.first_name || ' ' || u.last_name AS agent_name,
  ci.escalation_urgency,
  ci.escalation_reason,
  ci.escalation_target,
  ci.health_score,
  ci.sentiment_label,
  ci.analysis_timestamp,
  conv.last_message_at
FROM conversation_insights ci
LEFT JOIN contacts c ON ci.contact_id = c.id
LEFT JOIN users u ON ci.agent_id = u.id
LEFT JOIN conversations conv ON ci.conversation_id = conv.id
WHERE ci.escalation_recommended = true
  AND ci.escalation_urgency IN ('high', 'critical')
ORDER BY 
  CASE ci.escalation_urgency
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
  END,
  ci.analysis_timestamp DESC;

-- AI ISA validation mismatches view
CREATE OR REPLACE VIEW ai_isa_validation_mismatches AS
SELECT 
  ci.id,
  ci.conversation_id,
  ci.contact_id,
  c.first_name || ' ' || c.last_name AS contact_name,
  ci.ai_isa_confidence,
  ci.ai_isa_validation_result,
  ci.ai_isa_discrepancy_details,
  ci.sentiment_score,
  ci.health_score,
  ci.analysis_timestamp
FROM conversation_insights ci
LEFT JOIN contacts c ON ci.contact_id = c.id
WHERE ci.ai_isa_validation_result = 'mismatch'
ORDER BY ci.analysis_timestamp DESC;

-- Conversation health summary view
CREATE OR REPLACE VIEW conversation_health_summary AS
SELECT 
  ci.agent_id,
  u.first_name || ' ' || u.last_name AS agent_name,
  COUNT(*) AS total_conversations,
  AVG(ci.health_score) AS avg_health_score,
  COUNT(CASE WHEN ci.health_score < 40 THEN 1 END) AS unhealthy_conversations,
  COUNT(CASE WHEN ci.escalation_recommended = true THEN 1 END) AS escalations_recommended,
  COUNT(CASE WHEN ci.sentiment_label IN ('frustrated', 'confused') THEN 1 END) AS negative_sentiment_count
FROM conversation_insights ci
LEFT JOIN users u ON ci.agent_id = u.id
WHERE ci.analysis_timestamp >= now() - interval '7 days'
GROUP BY ci.agent_id, u.first_name, u.last_name
ORDER BY avg_health_score ASC;

COMMIT;
