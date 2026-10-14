-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DEAD — DO NOT RE-RUN. The `vendor_directory` table this file touches no   ║
-- ║ longer exists: m355 folded its curation columns onto `vendors` and        ║
-- ║ dropped it (one vendor system, per the owner's ruling on drift).          ║
-- ║ Re-running would recreate it AND point vendor_jobs.vendor_id at it — that ║
-- ║ FK targets vendors(id) in production.                                    ║
-- ║ Kept only as the historical record of how the schema got here.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ============================================================================
-- EXTENDED AI SYSTEMS SCHEMA
-- Tables for: Property Matching, Contract Review, Communication Hub, 
-- Voice Transcription, Market Intelligence, Vendor Management, 
-- Training/Coaching, Listing Presentations
-- ============================================================================

-- Property Matching System
CREATE TABLE IF NOT EXISTS buyer_property_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id UUID NOT NULL,
  listing_id UUID,
  match_score NUMERIC,
  match_reasons JSONB,
  ai_analysis JSONB,
  status TEXT DEFAULT 'new',
  viewed_at TIMESTAMPTZ,
  feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS buyer_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  preferences JSONB,
  ai_inferred_preferences JSONB,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contract Review System
CREATE TABLE IF NOT EXISTS contract_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  transaction_id UUID,
  document_url TEXT,
  document_type TEXT,
  ai_analysis JSONB,
  issues_found JSONB,
  risk_level TEXT,
  compliance_status TEXT DEFAULT 'pending',
  reviewed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_review_id UUID REFERENCES contract_reviews(id) ON DELETE CASCADE,
  check_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  findings JSONB,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Communication Hub System
CREATE TABLE IF NOT EXISTS communication_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  contact_id UUID,
  thread_type TEXT,
  subject TEXT,
  last_message_at TIMESTAMPTZ,
  ai_sentiment TEXT,
  ai_priority TEXT,
  ai_suggested_action TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communication_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID REFERENCES communication_threads(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  content TEXT,
  ai_sentiment JSONB,
  ai_summary TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_response_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES communication_messages(id) ON DELETE CASCADE,
  suggested_response TEXT,
  response_type TEXT,
  confidence NUMERIC,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Voice Transcription System
CREATE TABLE IF NOT EXISTS call_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  contact_id UUID,
  call_type TEXT,
  duration_seconds INTEGER,
  audio_url TEXT,
  transcript TEXT,
  ai_summary TEXT,
  ai_analysis JSONB,
  sentiment_score NUMERIC,
  action_items JSONB,
  coaching_notes JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  total_calls INTEGER,
  avg_duration NUMERIC,
  sentiment_distribution JSONB,
  common_topics JSONB,
  improvement_areas JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Market Intelligence System
CREATE TABLE IF NOT EXISTS market_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  report_type TEXT,
  area TEXT,
  property_type TEXT,
  timeframe TEXT,
  analysis JSONB,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  alert_type TEXT,
  area TEXT,
  title TEXT,
  description TEXT,
  priority TEXT,
  data JSONB,
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  property_address TEXT,
  property_data JSONB,
  prediction JSONB,
  accuracy_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vendor Management System
CREATE TABLE IF NOT EXISTS vendor_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  service_type TEXT NOT NULL,
  specializations JSONB,
  pricing_tier TEXT,
  avg_rating NUMERIC,
  total_jobs INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  vendor_id UUID REFERENCES vendor_directory(id),
  listing_id UUID,
  service_type TEXT,
  status TEXT DEFAULT 'pending',
  scheduled_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cost NUMERIC,
  rating INTEGER,
  feedback TEXT,
  completed_on_time BOOLEAN,
  issues_reported TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID REFERENCES vendor_directory(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  job_id UUID REFERENCES vendor_jobs(id),
  rating INTEGER,
  review_text TEXT,
  quality_score INTEGER,
  timeliness_score INTEGER,
  communication_score INTEGER,
  value_score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_coordination_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  listing_id UUID,
  services JSONB,
  coordination_plan JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Training & Coaching System
CREATE TABLE IF NOT EXISTS agent_performance_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  broker_id UUID,
  analysis JSONB,
  timeframe TEXT,
  overall_score NUMERIC,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_learning_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  learning_path JSONB,
  focus_areas JSONB,
  status TEXT DEFAULT 'active',
  progress NUMERIC DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  difficulty TEXT,
  duration TEXT,
  content JSONB,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  course_id UUID REFERENCES training_courses(id),
  course_name TEXT,
  status TEXT DEFAULT 'not_started',
  progress NUMERIC DEFAULT 0,
  score NUMERIC,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS practice_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  scenario_type TEXT,
  transcript TEXT,
  evaluation JSONB,
  overall_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Presentation System
CREATE TABLE IF NOT EXISTS listing_presentations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  property_address TEXT,
  property_data JSONB,
  presentation JSONB,
  presentation_type TEXT,
  status TEXT DEFAULT 'draft',
  presented_at TIMESTAMPTZ,
  outcome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seller_net_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  listing_id UUID,
  sale_price NUMERIC,
  net_sheet JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_buyer_property_matches_buyer ON buyer_property_matches(buyer_id);
CREATE INDEX IF NOT EXISTS idx_buyer_property_matches_listing ON buyer_property_matches(listing_id);
CREATE INDEX IF NOT EXISTS idx_contract_reviews_agent ON contract_reviews(agent_id);
CREATE INDEX IF NOT EXISTS idx_contract_reviews_transaction ON contract_reviews(transaction_id);
CREATE INDEX IF NOT EXISTS idx_communication_threads_agent ON communication_threads(agent_id);
CREATE INDEX IF NOT EXISTS idx_communication_threads_contact ON communication_threads(contact_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_agent ON call_recordings(agent_id);
CREATE INDEX IF NOT EXISTS idx_market_reports_agent ON market_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_market_alerts_agent ON market_alerts(agent_id);
CREATE INDEX IF NOT EXISTS idx_vendor_jobs_agent ON vendor_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_vendor_jobs_vendor ON vendor_jobs(vendor_id);
CREATE INDEX IF NOT EXISTS idx_agent_performance_reports_agent ON agent_performance_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_learning_paths_agent ON agent_learning_paths(agent_id);
CREATE INDEX IF NOT EXISTS idx_listing_presentations_agent ON listing_presentations(agent_id);

-- Success message
SELECT 'Extended AI systems schema created successfully' as status;
