-- =====================================================
-- AI SMART ENGINE OS - Core Infrastructure Tables
-- Migration: 030-create-ai-smart-engine-tables.sql
-- Purpose: Support Real Estate AI agents, playbooks, and automation
-- =====================================================

-- =====================================================
-- ENUM TYPES
-- =====================================================

-- Service types for AI integrations
DO $$ BEGIN
  CREATE TYPE service_type AS ENUM ('llm', 'voice', 'search_assistant', 'workflow_orchestrator', 'crm');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Authentication types for external services
DO $$ BEGIN
  CREATE TYPE auth_type AS ENUM ('api_key', 'oauth', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Status types for services and instances
DO $$ BEGIN
  CREATE TYPE service_status AS ENUM ('active', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AI agent role types
DO $$ BEGIN
  CREATE TYPE ai_agent_role AS ENUM (
    'isa',              -- Inside Sales Agent
    'nurturer',         -- Long-term lead nurturing
    'feedback',         -- Collect client feedback
    'concierge',        -- Client experience manager
    'fsbo_prospector',  -- For Sale By Owner outreach
    'credit',           -- Credit repair/lender intro
    'copilot',          -- Agent assistant
    'video'             -- Video generation/outreach
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Owner types for agent instances
DO $$ BEGIN
  CREATE TYPE owner_type AS ENUM ('brokerage', 'team', 'agent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Instance status
DO $$ BEGIN
  CREATE TYPE instance_status AS ENUM ('active', 'paused', 'draft');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Trigger types for playbooks
DO $$ BEGIN
  CREATE TYPE trigger_type AS ENUM ('event', 'schedule', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Stage names for automation rules
DO $$ BEGIN
  CREATE TYPE stage_name AS ENUM ('new_lead', 'active_client', 'under_contract', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Error types for automation errors
DO $$ BEGIN
  CREATE TYPE error_type AS ENUM ('llm_failure', 'api_failure', 'validation_error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Error resolution status
DO $$ BEGIN
  CREATE TYPE error_status AS ENUM ('open', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- =====================================================
-- 1. SERVICES TABLE - External AI/Integration Services
-- =====================================================
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Service identification
  service_type service_type NOT NULL,
  name TEXT NOT NULL,  -- 'GPT', 'Claude', 'Gemini', 'Vapi', 'Perplexity', 'GHL'
  
  -- Connection configuration
  base_url TEXT,
  auth_type auth_type NOT NULL DEFAULT 'api_key',
  
  -- Service-specific configuration
  config JSONB DEFAULT '{}'::jsonb,
  -- Example config: { "model": "gpt-4o", "temperature": 0.7, "voice_id": "alloy", "language": "en-US" }
  
  -- Status tracking
  status service_status NOT NULL DEFAULT 'active',
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Constraints
  CONSTRAINT services_name_unique UNIQUE (name, service_type)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_services_type ON services(service_type);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

COMMENT ON TABLE services IS 'External AI and integration services (LLMs, Voice, CRM, etc.)';


-- =====================================================
-- 2. AI_AGENTS TABLE - AI Agent Blueprints
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Agent identification
  name TEXT NOT NULL,
  role_type ai_agent_role NOT NULL,
  description TEXT,
  
  -- Service references
  service_llm_id UUID REFERENCES services(id) ON DELETE SET NULL,
  service_voice_id UUID REFERENCES services(id) ON DELETE SET NULL,
  
  -- AI configuration
  default_prompt TEXT,
  config_schema JSONB DEFAULT '{}'::jsonb,
  -- Example: { "max_tokens": 2000, "personality": "friendly", "response_style": "concise" }
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Constraints
  CONSTRAINT ai_agents_name_role_unique UNIQUE (name, role_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ai_agents_role ON ai_agents(role_type);
CREATE INDEX IF NOT EXISTS idx_ai_agents_llm ON ai_agents(service_llm_id);

COMMENT ON TABLE ai_agents IS 'AI Agent blueprints defining capabilities and behavior';


-- =====================================================
-- 3. AI_AGENT_INSTANCES TABLE - Deployed Agent Instances
-- =====================================================
CREATE TABLE IF NOT EXISTS ai_agent_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Reference to blueprint
  agent_id UUID NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  
  -- Ownership (multi-tenant)
  owner_type owner_type NOT NULL,
  owner_id UUID NOT NULL,  -- References brokerage, team, or agent UUID
  
  -- Channel configuration
  channels TEXT[] DEFAULT ARRAY['sms', 'email']::TEXT[],
  -- Options: 'sms', 'email', 'voice', 'dm', 'in_app'
  
  -- Instance-specific configuration (overrides blueprint defaults)
  config JSONB DEFAULT '{}'::jsonb,
  
  -- Status
  status instance_status NOT NULL DEFAULT 'draft',
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Constraints - one instance per agent per owner
  CONSTRAINT ai_agent_instances_unique UNIQUE (agent_id, owner_type, owner_id)
);

-- Indexes for multi-tenant queries
CREATE INDEX IF NOT EXISTS idx_ai_agent_instances_owner ON ai_agent_instances(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_instances_agent ON ai_agent_instances(agent_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_instances_status ON ai_agent_instances(status);

COMMENT ON TABLE ai_agent_instances IS 'Deployed AI agent instances per brokerage/team/agent';


-- =====================================================
-- 4. PLAYBOOKS TABLE - Automation Workflows
-- =====================================================
CREATE TABLE IF NOT EXISTS playbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Playbook identification
  name TEXT NOT NULL,
  purpose TEXT,
  
  -- Trigger configuration
  trigger_type trigger_type NOT NULL,
  trigger_event TEXT,  -- Event name like 'new_lead', 'appointment_scheduled', etc.
  
  -- Audience targeting
  audience_filter JSONB DEFAULT '{}'::jsonb,
  -- Example: { "contact_type": ["buyer"], "timeline": ["immediate", "30_days"], "status": ["new", "contacted"] }
  
  -- AI Agent assignment
  ai_agent_instance_id UUID REFERENCES ai_agent_instances(id) ON DELETE SET NULL,
  
  -- Execution configuration
  channels TEXT[] DEFAULT ARRAY['email']::TEXT[],
  tools_used TEXT[] DEFAULT ARRAY[]::TEXT[],
  -- Example tools: ['send_sms', 'schedule_call', 'create_task', 'update_status']
  
  -- Workflow definition
  definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Full workflow steps, conditions, branching logic
  
  -- KPI and goals
  kpi_targets TEXT,
  
  -- Ownership for multi-tenant
  owner_type owner_type NOT NULL DEFAULT 'brokerage',
  owner_id UUID,
  
  -- Status
  is_active BOOLEAN DEFAULT true,
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_playbooks_trigger ON playbooks(trigger_type, trigger_event);
CREATE INDEX IF NOT EXISTS idx_playbooks_agent ON playbooks(ai_agent_instance_id);
CREATE INDEX IF NOT EXISTS idx_playbooks_owner ON playbooks(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_playbooks_active ON playbooks(is_active);

COMMENT ON TABLE playbooks IS 'Automation playbooks defining workflow triggers and actions';


-- =====================================================
-- 5. STAGE_AUTOMATION_RULES TABLE - Per-Stage Rules
-- =====================================================
CREATE TABLE IF NOT EXISTS stage_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Stage identification
  stage_name stage_name NOT NULL,
  
  -- Auto-send messages (no approval needed)
  auto_messages JSONB DEFAULT '{}'::jsonb,
  -- Example: { "new_lead": "welcome_template", "appointment_confirmed": "confirmation_template" }
  
  -- Draft-only messages (requires human approval)
  draft_only_messages JSONB DEFAULT '{}'::jsonb,
  -- Example: { "price_reduction": true, "commission_negotiation": true }
  
  -- Auto-create tasks
  auto_tasks JSONB DEFAULT '{}'::jsonb,
  -- Example: { "new_lead": ["schedule_call", "send_welcome"], "under_contract": ["order_inspection"] }
  
  -- Human-only topics (AI should not respond)
  human_only JSONB DEFAULT '{}'::jsonb,
  -- Example: { "topics": ["legal_advice", "contract_disputes", "discrimination_claims"] }
  
  -- Ownership for multi-tenant
  owner_type owner_type NOT NULL DEFAULT 'brokerage',
  owner_id UUID,
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- One rule set per stage per owner
  CONSTRAINT stage_rules_unique UNIQUE (stage_name, owner_type, owner_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stage_rules_stage ON stage_automation_rules(stage_name);
CREATE INDEX IF NOT EXISTS idx_stage_rules_owner ON stage_automation_rules(owner_type, owner_id);

COMMENT ON TABLE stage_automation_rules IS 'Per-stage automation rules defining AI behavior boundaries';


-- =====================================================
-- 6. AUTOMATION_ERRORS TABLE - Error Tracking
-- =====================================================
CREATE TABLE IF NOT EXISTS automation_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Error context
  workflow_name TEXT NOT NULL,
  context_id UUID,  -- Reference to contact, transaction, etc.
  
  -- Error details
  error_type error_type NOT NULL,
  message TEXT NOT NULL,
  raw_response JSONB,  -- Full API response for debugging
  
  -- Resolution tracking
  status error_status NOT NULL DEFAULT 'open',
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolution_notes TEXT,
  
  -- Ownership for multi-tenant
  owner_type owner_type,
  owner_id UUID,
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for quick error resolution
CREATE INDEX IF NOT EXISTS idx_automation_errors_status ON automation_errors(status);
CREATE INDEX IF NOT EXISTS idx_automation_errors_workflow ON automation_errors(workflow_name);
CREATE INDEX IF NOT EXISTS idx_automation_errors_type ON automation_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_automation_errors_created ON automation_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_errors_owner ON automation_errors(owner_type, owner_id);

COMMENT ON TABLE automation_errors IS 'Tracking automation failures for debugging and resolution';


-- =====================================================
-- 7. OVERRIDE_LOG TABLE - Audit Trail for Changes
-- =====================================================
CREATE TABLE IF NOT EXISTS override_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- What was changed
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  field_name TEXT NOT NULL,
  
  -- Change details
  old_value TEXT,
  new_value TEXT,
  
  -- Who made the change
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Why it was changed
  note TEXT,
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_override_log_table ON override_log(table_name);
CREATE INDEX IF NOT EXISTS idx_override_log_record ON override_log(record_id);
CREATE INDEX IF NOT EXISTS idx_override_log_user ON override_log(user_id);
CREATE INDEX IF NOT EXISTS idx_override_log_created ON override_log(created_at DESC);

COMMENT ON TABLE override_log IS 'Audit trail for manual data overrides';


-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE override_log ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- SERVICES - All authenticated users can read, admins can modify
-- =====================================================
DROP POLICY IF EXISTS "Services are viewable by authenticated users" ON services;
CREATE POLICY "Services are viewable by authenticated users" ON services
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Services are manageable by admins" ON services;
CREATE POLICY "Services are manageable by admins" ON services
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- =====================================================
-- AI_AGENTS - Blueprints are viewable by all, manageable by admins
-- =====================================================
DROP POLICY IF EXISTS "AI Agents are viewable by authenticated users" ON ai_agents;
CREATE POLICY "AI Agents are viewable by authenticated users" ON ai_agents
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "AI Agents are manageable by admins" ON ai_agents;
CREATE POLICY "AI Agents are manageable by admins" ON ai_agents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- =====================================================
-- AI_AGENT_INSTANCES - Multi-tenant isolation
-- =====================================================
DROP POLICY IF EXISTS "Agent instances are viewable by owner hierarchy" ON ai_agent_instances;
CREATE POLICY "Agent instances are viewable by owner hierarchy" ON ai_agent_instances
  FOR SELECT USING (
    -- Admins/Brokers see all in their org
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    -- Agents see their own instances
    (owner_type = 'agent' AND owner_id = auth.uid())
    OR
    -- Team members see team instances (requires team membership check)
    (owner_type = 'team' AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid()
      -- Add team membership logic here when teams table exists
    ))
  );

DROP POLICY IF EXISTS "Agent instances are manageable by owners" ON ai_agent_instances;
CREATE POLICY "Agent instances are manageable by owners" ON ai_agent_instances
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    (owner_type = 'agent' AND owner_id = auth.uid())
  );

-- =====================================================
-- PLAYBOOKS - Multi-tenant isolation
-- =====================================================
DROP POLICY IF EXISTS "Playbooks are viewable by owner hierarchy" ON playbooks;
CREATE POLICY "Playbooks are viewable by owner hierarchy" ON playbooks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    (owner_type = 'agent' AND owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Playbooks are manageable by owners" ON playbooks;
CREATE POLICY "Playbooks are manageable by owners" ON playbooks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    (owner_type = 'agent' AND owner_id = auth.uid())
  );

-- =====================================================
-- STAGE_AUTOMATION_RULES - Multi-tenant isolation
-- =====================================================
DROP POLICY IF EXISTS "Stage rules are viewable by owner hierarchy" ON stage_automation_rules;
CREATE POLICY "Stage rules are viewable by owner hierarchy" ON stage_automation_rules
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    (owner_type = 'agent' AND owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Stage rules are manageable by admins" ON stage_automation_rules;
CREATE POLICY "Stage rules are manageable by admins" ON stage_automation_rules
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- =====================================================
-- AUTOMATION_ERRORS - Multi-tenant isolation
-- =====================================================
DROP POLICY IF EXISTS "Automation errors are viewable by owner hierarchy" ON automation_errors;
CREATE POLICY "Automation errors are viewable by owner hierarchy" ON automation_errors
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    (owner_type = 'agent' AND owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Automation errors are resolvable by admins and owners" ON automation_errors;
CREATE POLICY "Automation errors are resolvable by admins and owners" ON automation_errors
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    (owner_type = 'agent' AND owner_id = auth.uid())
  );

-- =====================================================
-- OVERRIDE_LOG - Read-only for owners, write for all authenticated
-- =====================================================
DROP POLICY IF EXISTS "Override log is viewable by admins" ON override_log;
CREATE POLICY "Override log is viewable by admins" ON override_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
    OR
    user_id = auth.uid()
  );

DROP POLICY IF EXISTS "Override log is insertable by authenticated users" ON override_log;
CREATE POLICY "Override log is insertable by authenticated users" ON override_log
  FOR INSERT WITH CHECK (user_id = auth.uid());


-- =====================================================
-- UPDATED_AT TRIGGER FUNCTION
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables with updated_at
DROP TRIGGER IF EXISTS update_services_updated_at ON services;
CREATE TRIGGER update_services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ai_agents_updated_at ON ai_agents;
CREATE TRIGGER update_ai_agents_updated_at
  BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_ai_agent_instances_updated_at ON ai_agent_instances;
CREATE TRIGGER update_ai_agent_instances_updated_at
  BEFORE UPDATE ON ai_agent_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_playbooks_updated_at ON playbooks;
CREATE TRIGGER update_playbooks_updated_at
  BEFORE UPDATE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_stage_automation_rules_updated_at ON stage_automation_rules;
CREATE TRIGGER update_stage_automation_rules_updated_at
  BEFORE UPDATE ON stage_automation_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =====================================================
-- SEED DEFAULT SERVICES
-- =====================================================
INSERT INTO services (service_type, name, base_url, auth_type, config, status) VALUES
  ('llm', 'GPT-4o', 'https://api.openai.com/v1', 'api_key', '{"model": "gpt-4o", "temperature": 0.7, "max_tokens": 4000}', 'active'),
  ('llm', 'Claude', 'https://api.anthropic.com/v1', 'api_key', '{"model": "claude-sonnet-4-20250514", "temperature": 0.7, "max_tokens": 4000}', 'active'),
  ('llm', 'Gemini', 'https://generativelanguage.googleapis.com/v1', 'api_key', '{"model": "gemini-pro", "temperature": 0.7}', 'active'),
  ('voice', 'Vapi', 'https://api.vapi.ai', 'api_key', '{"voice_id": "alloy", "language": "en-US"}', 'active'),
  ('search_assistant', 'Perplexity', 'https://api.perplexity.ai', 'api_key', '{"model": "pplx-7b-online"}', 'active'),
  ('crm', 'GoHighLevel', 'https://rest.gohighlevel.com/v1', 'api_key', '{"location_id": null}', 'paused'),
  ('workflow_orchestrator', 'Internal', NULL, 'none', '{"engine": "vipos_workflow"}', 'active')
ON CONFLICT (name, service_type) DO NOTHING;


-- =====================================================
-- SEED DEFAULT AI AGENTS
-- =====================================================
INSERT INTO ai_agents (name, role_type, description, default_prompt, config_schema) VALUES
  ('ISA Agent', 'isa', 'Inside Sales Agent for lead qualification and appointment setting', 
   'You are an Inside Sales Agent for a real estate team. Your goal is to qualify leads, answer questions about properties, and schedule appointments with agents. Be friendly, professional, and helpful.',
   '{"max_follow_ups": 5, "response_time_target": "5min", "qualification_criteria": ["timeline", "budget", "motivation"]}'),
  
  ('Nurture Agent', 'nurturer', 'Long-term lead nurturing with personalized touchpoints',
   'You are a nurturing specialist. Your role is to maintain relationships with leads who are not ready to buy/sell immediately. Send helpful market updates, home tips, and check in periodically.',
   '{"nurture_frequency": "weekly", "content_types": ["market_update", "home_tips", "local_events"]}'),
  
  ('Feedback Agent', 'feedback', 'Collect and analyze client feedback after showings and closings',
   'You are a feedback specialist. After showings or transactions, reach out to collect feedback. Be empathetic and professional. Summarize feedback for the agent.',
   '{"survey_types": ["showing", "closing", "annual_review"]}'),
  
  ('Concierge Agent', 'concierge', 'Client experience manager for active transactions',
   'You are a transaction concierge. Keep clients informed about their transaction progress, coordinate with vendors, and ensure a smooth experience from contract to close.',
   '{"update_frequency": "daily", "milestone_notifications": true}'),
  
  ('FSBO Prospector', 'fsbo_prospector', 'For Sale By Owner outreach and conversion',
   'You are an FSBO specialist. Reach out to For Sale By Owner listings to offer assistance. Be respectful, provide value, and highlight benefits of professional representation.',
   '{"outreach_cadence": "3_touches", "value_props": ["marketing", "negotiation", "legal_protection"]}'),
  
  ('Credit Agent', 'credit', 'Credit repair referrals and lender introductions',
   'You are a credit and financing specialist. Help leads understand their financing options, connect them with trusted lenders, and provide resources for credit improvement if needed.',
   '{"lender_partners": [], "credit_resources": true}'),
  
  ('Copilot Agent', 'copilot', 'Real-time agent assistant for daily tasks',
   'You are an AI copilot for a real estate agent. Help with scheduling, task management, market research, and communication drafting. Be proactive and efficient.',
   '{"task_types": ["scheduling", "research", "drafting", "reminders"]}'),
  
  ('Video Agent', 'video', 'AI-powered video generation and outreach',
   'You create personalized video content for leads and clients. Generate scripts, coordinate with video tools, and track engagement.',
   '{"video_types": ["introduction", "listing_tour", "market_update", "thank_you"]}')
ON CONFLICT (name, role_type) DO NOTHING;


-- =====================================================
-- SEED DEFAULT STAGE AUTOMATION RULES
-- =====================================================
INSERT INTO stage_automation_rules (stage_name, auto_messages, draft_only_messages, auto_tasks, human_only, owner_type) VALUES
  ('new_lead', 
   '{"lead_received": "welcome_sms", "first_response": "intro_email"}',
   '{"price_discussion": true, "commission": true}',
   '{"on_create": ["schedule_call", "send_welcome_packet", "add_to_nurture"]}',
   '{"topics": ["legal_advice", "discrimination", "contract_disputes"]}',
   'brokerage'),
  
  ('active_client',
   '{"appointment_confirmed": "confirmation_sms", "showing_scheduled": "showing_details"}',
   '{"offer_strategy": true, "negotiation_terms": true}',
   '{"on_showing": ["prepare_cma", "follow_up_call"], "on_offer": ["review_terms", "schedule_presentation"]}',
   '{"topics": ["legal_advice", "inspection_disputes", "earnest_money_release"]}',
   'brokerage'),
  
  ('under_contract',
   '{"contract_accepted": "congratulations_email", "milestone_complete": "progress_update"}',
   '{"repair_negotiations": true, "closing_cost_changes": true}',
   '{"on_contract": ["order_inspection", "coordinate_lender", "schedule_appraisal"]}',
   '{"topics": ["legal_advice", "title_issues", "loan_denial"]}',
   'brokerage'),
  
  ('closed',
   '{"closing_complete": "thank_you_video", "30_day_followup": "check_in_email"}',
   '{"referral_request": false}',
   '{"on_close": ["send_gift", "request_review", "add_to_past_client_nurture"]}',
   '{"topics": ["post_close_legal", "warranty_disputes"]}',
   'brokerage')
ON CONFLICT (stage_name, owner_type, owner_id) DO NOTHING;


-- Success message
DO $$
BEGIN
  RAISE NOTICE 'AI Smart Engine OS tables created successfully!';
  RAISE NOTICE 'Tables created: services, ai_agents, ai_agent_instances, playbooks, stage_automation_rules, automation_errors, override_log';
  RAISE NOTICE 'RLS policies applied for multi-tenant isolation';
  RAISE NOTICE 'Default services and AI agents seeded';
END $$;
