-- =====================================================
-- 006: DOCUMENTS POLICIES
-- =====================================================
-- Governance: Documents are highly sensitive and require strict access control
-- Compliance: Document access must be auditable and follow privacy regulations

-- Enable RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- SELECT POLICIES
-- =====================================================

-- Policy: Users can view documents in their brokerage
DROP POLICY IF EXISTS "users_view_brokerage_documents" ON documents;
CREATE POLICY "users_view_brokerage_documents"
  ON documents
  FOR SELECT
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
  );

-- Policy: Agents can view documents related to their contacts
DROP POLICY IF EXISTS "agents_view_contact_documents" ON documents;
CREATE POLICY "agents_view_contact_documents"
  ON documents
  FOR SELECT
  USING (
    auth_helpers.user_has_role('agent')
    AND (
      contact_id IN (
        SELECT id FROM contacts
        WHERE agent_id = auth_helpers.get_user_agent_id()
      )
      OR
      transaction_id IN (
        SELECT id FROM transactions
        WHERE agent_id = auth_helpers.get_user_agent_id()
      )
    )
  );

-- Policy: Transaction Coordinators can view transaction documents
DROP POLICY IF EXISTS "tc_view_transaction_documents" ON documents;
CREATE POLICY "tc_view_transaction_documents"
  ON documents
  FOR SELECT
  USING (
    auth_helpers.user_has_role('transaction_coordinator')
    AND transaction_id IN (
      SELECT id FROM transactions
      WHERE brokerage_id = auth_helpers.get_user_brokerage_id()
    )
  );

-- Policy: Brokers can view all documents in their brokerage
DROP POLICY IF EXISTS "brokers_view_all_documents" ON documents;
CREATE POLICY "brokers_view_all_documents"
  ON documents
  FOR SELECT
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  );

-- Policy: Admins can view all documents
DROP POLICY IF EXISTS "admins_view_all_documents" ON documents;
CREATE POLICY "admins_view_all_documents"
  ON documents
  FOR SELECT
  USING (auth_helpers.user_has_role('admin'));

-- =====================================================
-- INSERT POLICIES
-- =====================================================

-- Policy: Agents can upload documents for their contacts/transactions
DROP POLICY IF EXISTS "agents_create_documents" ON documents;
CREATE POLICY "agents_create_documents"
  ON documents
  FOR INSERT
  WITH CHECK (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('agent')
    AND uploaded_by = auth.uid()
  );

-- Policy: Transaction Coordinators can upload transaction documents
DROP POLICY IF EXISTS "tc_create_transaction_documents" ON documents;
CREATE POLICY "tc_create_transaction_documents"
  ON documents
  FOR INSERT
  WITH CHECK (
    auth_helpers.user_has_role('transaction_coordinator')
    AND brokerage_id = auth_helpers.get_user_brokerage_id()
    AND uploaded_by = auth.uid()
    AND transaction_id IS NOT NULL
  );

-- Policy: Brokers can upload any document in their brokerage
DROP POLICY IF EXISTS "brokers_create_documents" ON documents;
CREATE POLICY "brokers_create_documents"
  ON documents
  FOR INSERT
  WITH CHECK (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  );

-- Policy: Admins can upload any document
DROP POLICY IF EXISTS "admins_create_documents" ON documents;
CREATE POLICY "admins_create_documents"
  ON documents
  FOR INSERT
  WITH CHECK (auth_helpers.user_has_role('admin'));

-- =====================================================
-- UPDATE POLICIES
-- =====================================================

-- Policy: Users can update documents they uploaded
DROP POLICY IF EXISTS "users_update_own_documents" ON documents;
CREATE POLICY "users_update_own_documents"
  ON documents
  FOR UPDATE
  USING (uploaded_by = auth.uid())
  WITH CHECK (uploaded_by = auth.uid());

-- Policy: Brokers can update any document in their brokerage
DROP POLICY IF EXISTS "brokers_update_brokerage_documents" ON documents;
CREATE POLICY "brokers_update_brokerage_documents"
  ON documents
  FOR UPDATE
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  )
  WITH CHECK (
    brokerage_id = auth_helpers.get_user_brokerage_id()
  );

-- Policy: Admins can update any document
DROP POLICY IF EXISTS "admins_update_all_documents" ON documents;
CREATE POLICY "admins_update_all_documents"
  ON documents
  FOR UPDATE
  USING (auth_helpers.user_has_role('admin'))
  WITH CHECK (auth_helpers.user_has_role('admin'));

-- =====================================================
-- DELETE POLICIES
-- =====================================================

-- Policy: Users can delete documents they uploaded (soft delete recommended)
DROP POLICY IF EXISTS "users_delete_own_documents" ON documents;
CREATE POLICY "users_delete_own_documents"
  ON documents
  FOR DELETE
  USING (uploaded_by = auth.uid());

-- Policy: Brokers can delete any document in their brokerage
DROP POLICY IF EXISTS "brokers_delete_brokerage_documents" ON documents;
CREATE POLICY "brokers_delete_brokerage_documents"
  ON documents
  FOR DELETE
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  );

-- Policy: Admins can delete any document
DROP POLICY IF EXISTS "admins_delete_all_documents" ON documents;
CREATE POLICY "admins_delete_all_documents"
  ON documents
  FOR DELETE
  USING (auth_helpers.user_has_role('admin'));

-- =====================================================
-- DOCUMENT VERSIONS POLICIES (if document_versions exists)
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'document_versions') THEN
    ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

    -- Users can view versions of documents they can access
    DROP POLICY IF EXISTS "users_view_document_versions" ON document_versions;
    CREATE POLICY "users_view_document_versions"
      ON document_versions
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = document_versions.document_id
          AND d.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- Users can create versions for documents they can access
    DROP POLICY IF EXISTS "users_create_document_versions" ON document_versions;
    CREATE POLICY "users_create_document_versions"
      ON document_versions
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = document_versions.document_id
          AND d.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- Admins can manage all document versions
    DROP POLICY IF EXISTS "admins_manage_all_document_versions" ON document_versions;
    CREATE POLICY "admins_manage_all_document_versions"
      ON document_versions
      FOR ALL
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON TABLE documents IS 'RLS Policies Applied: 006-documents-policies.sql - Enforces strict document access control with audit trails and privacy compliance';
