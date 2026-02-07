-- =====================================================
-- SYSTEM 3.4: CONVERSATION INTELLIGENCE & ESCALATION SIGNAL ENGINE
-- =====================================================
-- Creates the conversation_insights table and adds sentiment fields to messages
-- This system analyzes conversations for sentiment, health, escalation signals,
-- and AI ISA validation. It is READ-ONLY with respect to communications.

-- Add sentiment fields to messages table
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS sentiment VARCHAR(20) CHECK (sentiment IN ('positive', 'neutral', 'negative')),
ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC(3, 2) CHECK (sentiment_score >= 0 AND sentiment_score <= 1),
ADD COLUMN IF NOT EXISTS emotion_tags JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS urgency_indicators TEXT[],
ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;

-- Create index for sentiment queries
CREATE INDEX IF NOT EXISTS idx_messages_sentiment ON messages(sentiment);
CREATE INDEX IF NOT EXISTS idx_messages_sentiment_score ON messages(sentiment_score);

-- Create conversation_insights table
CREATE TABLE IF NOT EXISTS conversation_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES users(id),
  
  -- Sentiment Analysis
  overall_sentiment VARCHAR(20) CHECK (overall_sentiment IN ('positive', 'neutral', 'negative')),
  sentiment_trajectory VARCHAR(20) CHECK (sentiment_trajectory IN ('improving', 'declining', 'stable', 'mixed')),
  sentiment_confidence NUMERIC(3, 2) CHECK (sentiment_confidence >= 0 AND sentiment_confidence <= 1),
  emotional_state JSONB, -- {dominant_emotion, intensity, secondary_emotions[]}
  
  -- Conversation Health
  health_score NUMERIC(3, 2) CHECK (health_score >= 0 AND health_score <= 1),
  health_factors JSONB, -- {response_time_avg, message_balance, engagement_level, question_answer_ratio}
  response_time_avg_seconds INTEGER,
  message_balance_ratio NUMERIC(3, 2), -- ratio of agent:contact messages
  unanswered_questions_count INTEGER DEFAULT 0,
  
  -- Escalation Signals
  escalation_recommended BOOLEAN DEFAULT FALSE,
  escalation_urgency VARCHAR(20) CHECK (escalation_urgency IN ('low', 'medium', 'high', 'critical')),
  escalation_reasons TEXT[],
  escalation_target VARCHAR(50), -- 'agent', 'supervisor', 'support', 'admin'
  escalation_confidence NUMERIC(3, 2) CHECK (escalation_confidence >= 0 AND escalation_confidence <= 1),
  
  -- AI ISA Validation
  ai_isa_confidence_match BOOLEAN,
  ai_vs_reality_delta NUMERIC(3, 2), -- difference between AI confidence and actual conversation quality
  ai_correction_needed BOOLEAN DEFAULT FALSE,
  ai_caution_flags TEXT[],
  
  -- Voice-Specific Intelligence
  is_voice_conversation BOOLEAN DEFAULT FALSE,
  voice_quality_score NUMERIC(3, 2) CHECK (voice_quality_score >= 0 AND voice_quality_score <= 1),
  interruption_count INTEGER DEFAULT 0,
  silence_duration_seconds INTEGER DEFAULT 0,
  call_completion_status VARCHAR(50), -- 'completed', 'dropped', 'failed', 'no_answer'
  
  -- Context & Topics
  key_topics JSONB DEFAULT '[]'::jsonb,
  pain_points TEXT[],
  objections_raised TEXT[],
  buying_signals TEXT[],
  
  -- Metadata
  analysis_timestamp TIMESTAMPTZ DEFAULT NOW(),
  analysis_version VARCHAR(20) DEFAULT '1.0',
  confidence_overall NUMERIC(3, 2) CHECK (confidence_overall >= 0 AND confidence_overall <= 1),
  requires_human_review BOOLEAN DEFAULT FALSE,
  review_notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT unique_conversation_insight UNIQUE(conversation_id, analysis_timestamp)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_conversation_insights_conversation_id ON conversation_insights(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_contact_id ON conversation_insights(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_agent_id ON conversation_insights(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_health_score ON conversation_insights(health_score);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_escalation ON conversation_insights(escalation_recommended, escalation_urgency);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_sentiment ON conversation_insights(overall_sentiment);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_timestamp ON conversation_insights(analysis_timestamp DESC);

-- Enable RLS
ALTER TABLE conversation_insights ENABLE ROW LEVEL SECURITY;

-- RLS Policies for conversation_insights
CREATE POLICY "Users can view insights for their conversations"
  ON conversation_insights FOR SELECT
  USING (
    agent_id = auth.uid()
    OR contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

CREATE POLICY "System can insert insights"
  ON conversation_insights FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update insights"
  ON conversation_insights FOR UPDATE
  USING (true);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_conversation_insights_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trigger_update_conversation_insights_timestamp ON conversation_insights;
CREATE TRIGGER trigger_update_conversation_insights_timestamp
  BEFORE UPDATE ON conversation_insights
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_insights_updated_at();

-- Create view for high-priority escalations
CREATE OR REPLACE VIEW escalation_dashboard AS
SELECT 
  ci.id as insight_id,
  ci.conversation_id,
  ci.contact_id,
  ci.agent_id,
  c.first_name || ' ' || c.last_name as contact_name,
  c.phone,
  c.email,
  ci.escalation_urgency,
  ci.escalation_reasons,
  ci.escalation_target,
  ci.health_score,
  ci.overall_sentiment,
  ci.unanswered_questions_count,
  ci.analysis_timestamp,
  conv.last_message_at,
  conv.message_count
FROM conversation_insights ci
JOIN contacts c ON ci.contact_id = c.id
JOIN conversations conv ON ci.conversation_id = conv.id
WHERE ci.escalation_recommended = TRUE
  AND ci.requires_human_review = FALSE
ORDER BY 
  CASE ci.escalation_urgency
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  ci.analysis_timestamp DESC;

-- Create view for AI ISA validation issues
CREATE OR REPLACE VIEW ai_isa_validation_dashboard AS
SELECT 
  ci.id as insight_id,
  ci.conversation_id,
  ci.contact_id,
  c.first_name || ' ' || c.last_name as contact_name,
  ci.ai_isa_confidence_match,
  ci.ai_vs_reality_delta,
  ci.ai_correction_needed,
  ci.ai_caution_flags,
  ci.overall_sentiment,
  ci.health_score,
  ci.analysis_timestamp
FROM conversation_insights ci
JOIN contacts c ON ci.contact_id = c.id
WHERE ci.ai_correction_needed = TRUE
   OR ci.ai_isa_confidence_match = FALSE
   OR ABS(ci.ai_vs_reality_delta) > 0.3
ORDER BY ABS(ci.ai_vs_reality_delta) DESC, ci.analysis_timestamp DESC;

COMMENT ON TABLE conversation_insights IS 'System 3.4: Stores conversation intelligence analysis including sentiment, health scores, escalation signals, and AI validation';
COMMENT ON COLUMN conversation_insights.health_score IS 'Normalized conversation health score (0-1) based on response time, engagement, and message balance';
COMMENT ON COLUMN conversation_insights.escalation_recommended IS 'Whether this conversation should be escalated to human attention';
COMMENT ON COLUMN conversation_insights.ai_vs_reality_delta IS 'Difference between AI ISA confidence and actual conversation quality (-1 to 1)';
COMMENT ON VIEW escalation_dashboard IS 'Real-time view of conversations requiring escalation';
COMMENT ON VIEW ai_isa_validation_dashboard IS 'Conversations where AI ISA confidence mismatched reality';
