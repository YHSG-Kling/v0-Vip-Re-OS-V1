-- =====================================================
-- CONVERSATION ANALYTICS & SENTIMENT TRACKING
-- =====================================================
-- Tracks AI conversation metrics, sentiment analysis, and compliance audits

-- Conversation logs table for analytics
CREATE TABLE IF NOT EXISTS conversation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES users(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  duration_minutes INTEGER,
  ai_confidence_avg NUMERIC CHECK (ai_confidence_avg >= 0 AND ai_confidence_avg <= 1),
  sentiment_start TEXT CHECK (sentiment_start IN ('positive', 'neutral', 'negative')),
  sentiment_end TEXT CHECK (sentiment_end IN ('positive', 'neutral', 'negative')),
  sentiment_journey TEXT CHECK (sentiment_journey IN ('improved', 'declined', 'stable')),
  topics_discussed JSONB DEFAULT '[]'::jsonb,
  key_insights TEXT,
  channel TEXT CHECK (channel IN ('sms', 'email', 'voice', 'chat', 'ai_assistant')),
  conversation_type TEXT CHECK (conversation_type IN ('lead_nurture', 'showing_followup', 'offer_negotiation', 'transaction_update', 'general_inquiry')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Conversation audit flags for compliance
CREATE TABLE IF NOT EXISTS conversation_audit_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversation_logs(id) ON DELETE CASCADE,
  risk_type TEXT NOT NULL CHECK (risk_type IN ('compliance', 'fair_housing', 'hallucination', 'missed_opportunity', 'inappropriate_language', 'data_leak')),
  risk_score INTEGER NOT NULL CHECK (risk_score >= 1 AND risk_score <= 10),
  explanation TEXT NOT NULL,
  flagged_text TEXT,
  recommended_action TEXT,
  review_status TEXT DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed', 'dismissed', 'escalated')),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversation_logs_contact ON conversation_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_agent ON conversation_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_created ON conversation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_sentiment ON conversation_logs(sentiment_journey);
CREATE INDEX IF NOT EXISTS idx_audit_flags_conversation ON conversation_audit_flags(conversation_id);
CREATE INDEX IF NOT EXISTS idx_audit_flags_status ON conversation_audit_flags(review_status);
CREATE INDEX IF NOT EXISTS idx_audit_flags_risk ON conversation_audit_flags(risk_type, risk_score DESC);

-- Row Level Security
ALTER TABLE conversation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_audit_flags ENABLE ROW LEVEL SECURITY;

-- Policies: Agents can see their own conversations
CREATE POLICY conversation_logs_agent_policy ON conversation_logs
  FOR SELECT
  USING (
    agent_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker', 'compliance_officer')
    )
  );

CREATE POLICY conversation_logs_insert_policy ON conversation_logs
  FOR INSERT
  WITH CHECK (
    agent_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- Policies: Only compliance officers and admins can see audit flags
CREATE POLICY audit_flags_view_policy ON conversation_audit_flags
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker', 'compliance_officer')
    )
  );

CREATE POLICY audit_flags_insert_policy ON conversation_audit_flags
  FOR INSERT
  WITH CHECK (true); -- System can insert flags

CREATE POLICY audit_flags_update_policy ON conversation_audit_flags
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'compliance_officer')
    )
  );

-- Function to auto-calculate duration
CREATE OR REPLACE FUNCTION calculate_conversation_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
    NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_duration_trigger
  BEFORE INSERT OR UPDATE ON conversation_logs
  FOR EACH ROW
  EXECUTE FUNCTION calculate_conversation_duration();

COMMIT;
