-- =====================================================
-- RLS GOVERNANCE: LEADS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to leads (pre-contact stage)
-- Tables: leads, lead_enrichment_queue, raw_scraped_leads, lead_deduplication_log
-- Key Rule: Leads are INTERNAL ONLY — contacts NEVER see leads
-- =====================================================

-- Enable RLS
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_enrichment_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_scraped_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_deduplication_log ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- LEADS TABLE: SELECT POLICIES
-- =====================================================

-- Admin: Read all leads across all brokerages
CREATE POLICY "admin_read_all_leads"
  ON leads FOR SELECT
  USING (auth.is_admin());

-- Broker: Read all leads in their brokerage
CREATE POLICY "broker_read_brokerage_leads"
  ON leads FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Read own leads + unassigned leads in their brokerage
CREATE POLICY "agent_read_own_leads"
  ON leads FOR SELECT
  USING (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (
      agent_id = auth.uid() OR
      agent_id IS NULL -- Unassigned leads visible to all agents
    )
  );

-- Team Leader: Read team leads
CREATE POLICY "team_leader_read_team_leads"
  ON leads FOR SELECT
  USING (
    auth.is_team_leader()
    AND auth.has_brokerage_access(brokerage_id)
    AND (
      agent_id IN (
        SELECT id FROM users WHERE team_id = auth.user_team_id()
      ) OR
      agent_id IS NULL
    )
  );

-- Compliance: Read leads for auditing enrichment compliance
CREATE POLICY "compliance_read_leads_audit"
  ON leads FOR SELECT
  USING (
    auth.is_compliance_manager()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Contacts: NO ACCESS to leads table (leads are internal)

-- =====================================================
-- LEADS TABLE: INSERT POLICIES
-- =====================================================

-- Admin: Insert leads
CREATE POLICY "admin_insert_leads"
  ON leads FOR INSERT
  WITH CHECK (auth.is_admin());

-- Broker: Insert leads in their brokerage
CREATE POLICY "broker_insert_leads"
  ON leads FOR INSERT
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Insert leads in their brokerage (assigned to self)
CREATE POLICY "agent_insert_own_leads"
  ON leads FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.uid() OR agent_id IS NULL)
  );

-- System: Service role can insert leads (for automated scrapers)
-- This is handled by service_role_access policy

-- =====================================================
-- LEADS TABLE: UPDATE POLICIES
-- =====================================================

-- Admin: Update any lead
CREATE POLICY "admin_update_leads"
  ON leads FOR UPDATE
  USING (auth.is_admin());

-- Broker: Update leads in their brokerage
CREATE POLICY "broker_update_brokerage_leads"
  ON leads FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Update own leads (including assignment, status, scoring)
CREATE POLICY "agent_update_own_leads"
  ON leads FOR UPDATE
  USING (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.uid() OR agent_id IS NULL)
  );

-- Agent: Can claim unassigned leads
CREATE POLICY "agent_claim_unassigned_leads"
  ON leads FOR UPDATE
  USING (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND agent_id IS NULL
  )
  WITH CHECK (
    agent_id = auth.uid() -- Must assign to themselves
  );

-- =====================================================
-- LEADS TABLE: DELETE POLICIES
-- =====================================================

-- Only Admin can delete leads (for data integrity)
CREATE POLICY "admin_delete_leads"
  ON leads FOR DELETE
  USING (auth.is_admin());

-- Brokers can soft-delete (should use is_active flag instead)
CREATE POLICY "broker_deactivate_leads"
  ON leads FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  )
  WITH CHECK (
    is_active = false -- Only allow deactivation
  );

-- =====================================================
-- LEAD_ENRICHMENT_QUEUE TABLE POLICIES
-- =====================================================

-- Only system (service role) can manage enrichment queue
CREATE POLICY "service_role_manage_enrichment_queue"
  ON lead_enrichment_queue FOR ALL
  USING (auth.is_admin()); -- Admin can view for debugging

-- Brokers can view enrichment status for their leads
CREATE POLICY "broker_read_enrichment_queue"
  ON lead_enrichment_queue FOR SELECT
  USING (
    auth.is_broker()
    AND lead_id IN (
      SELECT id FROM leads WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- =====================================================
-- RAW_SCRAPED_LEADS TABLE POLICIES
-- =====================================================

-- Drop existing policies first
DROP POLICY IF EXISTS "Brokers and admins view raw leads" ON raw_scraped_leads;
DROP POLICY IF EXISTS "System insert raw leads" ON raw_scraped_leads;
DROP POLICY IF EXISTS "System update raw leads" ON raw_scraped_leads;

-- Admin: Full access to raw scraped data
CREATE POLICY "admin_full_access_raw_scraped"
  ON raw_scraped_leads FOR ALL
  USING (auth.is_admin());

-- Broker: Read raw scraped leads in their brokerage
CREATE POLICY "broker_read_raw_scraped"
  ON raw_scraped_leads FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Service role: Insert and update raw scraped leads
CREATE POLICY "service_insert_raw_scraped"
  ON raw_scraped_leads FOR INSERT
  WITH CHECK (true); -- Service role handles this

CREATE POLICY "service_update_raw_scraped"
  ON raw_scraped_leads FOR UPDATE
  USING (true); -- Service role handles this

-- =====================================================
-- LEAD_DEDUPLICATION_LOG TABLE POLICIES
-- =====================================================

-- Drop existing policy
DROP POLICY IF EXISTS "Brokers and admins can view dedup logs" ON lead_deduplication_log;

-- Admin: Full access to dedup logs
CREATE POLICY "admin_read_dedup_log"
  ON lead_deduplication_log FOR SELECT
  USING (auth.is_admin());

-- Broker: Read dedup logs for their brokerage leads
CREATE POLICY "broker_read_dedup_log"
  ON lead_deduplication_log FOR SELECT
  USING (
    auth.is_broker()
    AND (
      lead_id IN (SELECT id FROM leads WHERE brokerage_id = auth.user_brokerage_id()) OR
      duplicate_of_lead_id IN (SELECT id FROM leads WHERE brokerage_id = auth.user_brokerage_id())
    )
  );

-- Service role: Insert dedup logs
CREATE POLICY "service_insert_dedup_log"
  ON lead_deduplication_log FOR INSERT
  WITH CHECK (true);

-- =====================================================
-- COMMENTS
-- =====================================================
-- WHY these policies exist:
-- 1. Leads are INTERNAL and never visible to contacts
-- 2. Agents see their own leads + unassigned leads (for claiming)
-- 3. Brokers have full brokerage visibility for lead management
-- 4. Team leaders see team leads for oversight
-- 5. Enrichment queue is system-managed (service role)
-- 6. Raw scraped data is protected; only admins/brokers see it
-- 7. Deduplication log is audit-only (read-only for brokers)
-- 8. Lead assignment is explicit (agent_id field)
-- 9. Contacts can NEVER see lead scoring, intent, or enrichment data
-- =====================================================
