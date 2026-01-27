-- =====================================================
-- GRANULAR ACCESS CONTROL TABLES
-- =====================================================
-- Creates resource-level access control tables for fine-grained permissions
-- beyond role-based access. Allows explicit sharing and assignment.
-- =====================================================

-- Contact Access Control
CREATE TABLE IF NOT EXISTS contact_access_control (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_type TEXT NOT NULL, -- 'agent', 'broker', 'tc', 'compliance', etc.
  access_type TEXT NOT NULL DEFAULT 'assigned', -- 'assigned', 'shared', 'team'
  can_edit BOOLEAN DEFAULT false,
  can_delete BOOLEAN DEFAULT false,
  can_share BOOLEAN DEFAULT false,
  granted_by UUID REFERENCES users(id), -- Who granted this access
  granted_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP, -- Optional expiration
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(contact_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_access_contact_id ON contact_access_control(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_access_user_id ON contact_access_control(user_id);
CREATE INDEX IF NOT EXISTS idx_contact_access_expires_at ON contact_access_control(expires_at) WHERE expires_at IS NOT NULL;

-- Transaction Access Control
CREATE TABLE IF NOT EXISTS transaction_access_control (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_type TEXT NOT NULL, -- 'agent', 'broker', 'tc', 'compliance', etc.
  role_in_transaction TEXT NOT NULL DEFAULT 'participant', -- 'listing_agent', 'buyer_agent', 'tc', 'lender', 'title', etc.
  can_edit BOOLEAN DEFAULT false,
  can_view_financials BOOLEAN DEFAULT false,
  can_approve_milestones BOOLEAN DEFAULT false,
  can_upload_documents BOOLEAN DEFAULT true,
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(transaction_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_access_transaction_id ON transaction_access_control(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_access_user_id ON transaction_access_control(user_id);
CREATE INDEX IF NOT EXISTS idx_transaction_access_role ON transaction_access_control(role_in_transaction);

-- Document Access Control
CREATE TABLE IF NOT EXISTS document_access_control (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_type TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'view', -- 'view', 'download', 'edit', 'delete'
  can_share BOOLEAN DEFAULT false,
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(document_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_document_access_document_id ON document_access_control(document_id);
CREATE INDEX IF NOT EXISTS idx_document_access_user_id ON document_access_control(user_id);
CREATE INDEX IF NOT EXISTS idx_document_access_level ON document_access_control(access_level);

-- Listing Access Control
CREATE TABLE IF NOT EXISTS listing_access_control (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_type TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', -- 'listing_agent', 'co_listing_agent', 'viewer', 'editor'
  can_edit BOOLEAN DEFAULT false,
  can_approve BOOLEAN DEFAULT false,
  can_distribute BOOLEAN DEFAULT false,
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(listing_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_access_listing_id ON listing_access_control(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_access_user_id ON listing_access_control(user_id);

-- Access Audit Log (track all access grants/revokes)
CREATE TABLE IF NOT EXISTS access_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL, -- 'contact', 'transaction', 'document', 'listing'
  resource_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL, -- 'grant', 'revoke', 'modify'
  access_details JSONB, -- Details about what was granted/revoked
  performed_by UUID NOT NULL REFERENCES users(id),
  performed_at TIMESTAMP DEFAULT now(),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_audit_resource ON access_audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_user ON access_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_performed_at ON access_audit_log(performed_at);

-- RLS Policies for Access Control Tables
-- These ensure users can only see access grants they're involved in or manage

-- Contact Access Control RLS
ALTER TABLE contact_access_control ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own contact access"
  ON contact_access_control FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Admins/Brokers can view all contact access"
  ON contact_access_control FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_brokerage_roles ubr
      JOIN roles r ON ubr.role_id = r.id
      WHERE ubr.user_id = auth.uid()
      AND r.name IN ('BrokerOwner', 'ManagingBroker')
    )
  );

CREATE POLICY "Users can manage access they granted"
  ON contact_access_control FOR ALL
  USING (granted_by = auth.uid());

-- Transaction Access Control RLS
ALTER TABLE transaction_access_control ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own transaction access"
  ON transaction_access_control FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Admins/Brokers can view all transaction access"
  ON transaction_access_control FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_brokerage_roles ubr
      JOIN roles r ON ubr.role_id = r.id
      WHERE ubr.user_id = auth.uid()
      AND r.name IN ('BrokerOwner', 'ManagingBroker', 'TC')
    )
  );

-- Document Access Control RLS
ALTER TABLE document_access_control ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own document access"
  ON document_access_control FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Admins/Brokers can view all document access"
  ON document_access_control FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_brokerage_roles ubr
      JOIN roles r ON ubr.role_id = r.id
      WHERE ubr.user_id = auth.uid()
      AND r.name IN ('BrokerOwner', 'ManagingBroker', 'Compliance')
    )
  );

COMMIT;
