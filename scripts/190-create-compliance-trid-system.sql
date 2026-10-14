-- Comprehensive compliance tracking and audit trail system
-- TRID compliance, fair housing monitoring, certifications, document retention

-- Audit logs for all system actions
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id),
  action_type text NOT NULL, -- create, update, delete, view, export
  entity_type text NOT NULL, -- contact, transaction, document
  entity_id uuid NOT NULL,
  changes jsonb, -- before/after values
  ip_address text,
  user_agent text,
  timestamp timestamptz DEFAULT now(),
  compliance_relevant boolean DEFAULT false,
  brokerage_id uuid REFERENCES brokerages(id)
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_compliance ON audit_logs(compliance_relevant) WHERE compliance_relevant = true;

-- Compliance checklists for transactions
CREATE TABLE IF NOT EXISTS compliance_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE,
  checklist_type text, -- fair_housing, trid, disclosure, closing
  required_items jsonb,
  completed_items jsonb DEFAULT '[]'::jsonb,
  compliance_status text DEFAULT 'pending', -- pending, compliant, at_risk, non_compliant
  reviewed_by uuid REFERENCES profiles(id),
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_compliance_checklists_txn ON compliance_checklists(transaction_id);
CREATE INDEX idx_compliance_checklists_status ON compliance_checklists(compliance_status);

-- Agent certifications and license tracking
CREATE TABLE IF NOT EXISTS agent_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  certification_type text NOT NULL, -- license, e_o_insurance, mls_membership
  certification_number text,
  issued_date date,
  expiration_date date NOT NULL,
  status text DEFAULT 'active', -- active, expiring_soon, expired
  renewal_reminder_sent boolean DEFAULT false,
  document_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_agent_certs_agent ON agent_certifications(agent_id);
CREATE INDEX idx_agent_certs_expiration ON agent_certifications(expiration_date);
CREATE INDEX idx_agent_certs_status ON agent_certifications(status);

-- Document retention policies
CREATE TABLE IF NOT EXISTS document_retention (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES client_documents(id) ON DELETE CASCADE,
  retention_category text, -- transaction, disclosure, communication
  retention_years integer DEFAULT 7,
  transaction_close_date date,
  delete_after_date date, -- close_date + retention_years
  archived boolean DEFAULT false,
  archived_location text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_doc_retention_doc ON document_retention(document_id);
CREATE INDEX idx_doc_retention_delete ON document_retention(delete_after_date);

-- Fair housing compliance logs
CREATE TABLE IF NOT EXISTS fair_housing_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES profiles(id),
  interaction_type text, -- showing, communication, listing_presentation
  communication_text text,
  protected_class_mentioned boolean DEFAULT false,
  steering_risk_detected boolean DEFAULT false,
  ai_analysis jsonb,
  risk_score decimal(3,2), -- 0.00 to 1.00
  flagged_phrases text[],
  reviewed_by_compliance boolean DEFAULT false,
  reviewed_by uuid REFERENCES profiles(id),
  reviewed_at timestamptz,
  timestamp timestamptz DEFAULT now()
);

CREATE INDEX idx_fair_housing_contact ON fair_housing_logs(contact_id);
CREATE INDEX idx_fair_housing_agent ON fair_housing_logs(agent_id);
CREATE INDEX idx_fair_housing_risk ON fair_housing_logs(steering_risk_detected) WHERE steering_risk_detected = true;

-- TRID timeline tracking
CREATE TABLE IF NOT EXISTS trid_timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE,
  loan_application_date date,
  loan_estimate_delivered_date date,
  loan_estimate_received_date date,
  material_change_date date,
  revised_le_date date,
  closing_disclosure_prepared_date date,
  closing_disclosure_delivered_date date,
  closing_disclosure_received_date date,
  scheduled_close_date date,
  actual_close_date date,
  compliance_status text DEFAULT 'pending', -- compliant, at_risk, violation
  violations jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_trid_timeline_txn ON trid_timeline(transaction_id);
CREATE INDEX idx_trid_timeline_status ON trid_timeline(compliance_status);

-- Compliance alerts
CREATE TABLE IF NOT EXISTS compliance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE,
  alert_type text NOT NULL, -- TRID_VIOLATION, FAIR_HOUSING_RISK, CERT_EXPIRING, DOC_RETENTION
  severity text NOT NULL, -- low, medium, high, critical
  message text NOT NULL,
  details jsonb,
  acknowledged boolean DEFAULT false,
  acknowledged_by uuid REFERENCES profiles(id),
  acknowledged_at timestamptz,
  resolved boolean DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_compliance_alerts_txn ON compliance_alerts(transaction_id);
CREATE INDEX idx_compliance_alerts_severity ON compliance_alerts(severity);
CREATE INDEX idx_compliance_alerts_unresolved ON compliance_alerts(resolved) WHERE resolved = false;

-- RLS Policies
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE fair_housing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trid_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_alerts ENABLE ROW LEVEL SECURITY;

-- NOTE: Role gating uses the canonical table-driven SECURITY DEFINER helpers
-- from migration 033 (public.is_brokerage_admin / is_compliance_officer_role /
-- is_platform_admin). These resolve role + tenant from public.users via
-- auth.uid() and require NO custom JWT claims. Do NOT reintroduce
-- `auth.jwt() ->> 'user_role'` — nothing mints that claim and it always
-- evaluates to NULL. See migration m276 for the rationale.

-- Audit logs: Admins see all, agents see their own
CREATE POLICY "Audit logs viewable by role" ON audit_logs FOR SELECT USING (
  public.is_brokerage_admin()
  OR public.is_platform_admin()
  OR user_id = auth.uid()
);

-- Compliance checklists: Agents see their transactions
CREATE POLICY "Compliance checklists viewable by transaction access" ON compliance_checklists FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM transactions
    WHERE transactions.id = compliance_checklists.transaction_id
    AND transactions.agent_id = auth.uid()
  )
  OR public.is_brokerage_admin()
  OR public.is_platform_admin()
);

-- Agent certifications: Agents see their own, admins see all
CREATE POLICY "Agent certifications viewable by owner or admin" ON agent_certifications FOR SELECT USING (
  agent_id = auth.uid()
  OR public.is_brokerage_admin()
  OR public.is_platform_admin()
);

-- Fair housing logs: Admins and compliance officers only
CREATE POLICY "Fair housing logs viewable by compliance" ON fair_housing_logs FOR SELECT USING (
  public.is_brokerage_admin()
  OR public.is_compliance_officer_role()
  OR public.is_platform_admin()
);

-- TRID timeline: Transaction participants
CREATE POLICY "TRID timeline viewable by transaction access" ON trid_timeline FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM transactions
    WHERE transactions.id = trid_timeline.transaction_id
    AND transactions.agent_id = auth.uid()
  )
  OR public.is_brokerage_admin()
  OR public.is_platform_admin()
);

-- Compliance alerts: Transaction participants
CREATE POLICY "Compliance alerts viewable by transaction access" ON compliance_alerts FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM transactions
    WHERE transactions.id = compliance_alerts.transaction_id
    AND transactions.agent_id = auth.uid()
  )
  OR public.is_brokerage_admin()
  OR public.is_platform_admin()
);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_compliance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_compliance_checklists_updated_at
  BEFORE UPDATE ON compliance_checklists
  FOR EACH ROW
  EXECUTE FUNCTION update_compliance_updated_at();

CREATE TRIGGER update_trid_timeline_updated_at
  BEFORE UPDATE ON trid_timeline
  FOR EACH ROW
  EXECUTE FUNCTION update_compliance_updated_at();
