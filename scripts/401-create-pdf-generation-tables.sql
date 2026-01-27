-- PDF Document Generation and Storage System
-- Tracks all generated PDFs with blob storage links

-- Generated Documents Table
CREATE TABLE IF NOT EXISTS generated_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL CHECK (document_type IN ('cma', 'listing_packet', 'net_sheet', 'buyer_guide', 'seller_guide', 'offer_summary', 'contract_summary', 'closing_statement')),
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Blob storage
  blob_url TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  
  -- Versioning
  version INTEGER DEFAULT 1,
  supersedes_document_id UUID REFERENCES generated_documents(id) ON DELETE SET NULL,
  
  -- Tracking
  view_count INTEGER DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  downloaded_count INTEGER DEFAULT 0,
  last_downloaded_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- Optional expiration for temporary documents
  
  -- Indexes
  CONSTRAINT generated_documents_agent_id_idx CHECK (agent_id IS NOT NULL)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_generated_documents_contact ON generated_documents(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_documents_listing ON generated_documents(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_documents_transaction ON generated_documents(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generated_documents_agent ON generated_documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_generated_documents_type ON generated_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_generated_documents_created ON generated_documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_documents_expires ON generated_documents(expires_at) WHERE expires_at IS NOT NULL;

-- RLS Policies
ALTER TABLE generated_documents ENABLE ROW LEVEL SECURITY;

-- Agents can view their own documents
CREATE POLICY "Agents can view own generated documents"
  ON generated_documents FOR SELECT
  USING (auth.uid() = agent_id);

-- Agents can insert their own documents
CREATE POLICY "Agents can insert own generated documents"
  ON generated_documents FOR INSERT
  WITH CHECK (auth.uid() = agent_id);

-- Agents can update their own documents
CREATE POLICY "Agents can update own generated documents"
  ON generated_documents FOR UPDATE
  USING (auth.uid() = agent_id);

-- Agents can delete their own documents
CREATE POLICY "Agents can delete own generated documents"
  ON generated_documents FOR DELETE
  USING (auth.uid() = agent_id);

-- Brokers and admins can view all documents in their brokerage
CREATE POLICY "Brokers can view all generated documents"
  ON generated_documents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('broker', 'admin')
    )
  );

-- Document Email Log (track who received documents via email)
CREATE TABLE IF NOT EXISTS document_email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES generated_documents(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  subject TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  status TEXT CHECK (status IN ('sent', 'delivered', 'bounced', 'opened', 'clicked')) DEFAULT 'sent',
  
  -- Email service response
  email_service_id TEXT, -- External email service message ID
  error_message TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_email_log_document ON document_email_log(document_id);
CREATE INDEX IF NOT EXISTS idx_document_email_log_recipient ON document_email_log(recipient_email);
CREATE INDEX IF NOT EXISTS idx_document_email_log_sent ON document_email_log(sent_at DESC);

-- RLS for email log
ALTER TABLE document_email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view email logs for their documents"
  ON document_email_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM generated_documents
      WHERE generated_documents.id = document_email_log.document_id
      AND generated_documents.agent_id = auth.uid()
    )
  );

-- Function to track document views
CREATE OR REPLACE FUNCTION track_document_view(doc_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE generated_documents
  SET 
    view_count = view_count + 1,
    last_viewed_at = NOW()
  WHERE id = doc_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to track document downloads
CREATE OR REPLACE FUNCTION track_document_download(doc_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE generated_documents
  SET 
    downloaded_count = downloaded_count + 1,
    last_downloaded_at = NOW()
  WHERE id = doc_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to cleanup expired documents
CREATE OR REPLACE FUNCTION cleanup_expired_documents()
RETURNS void AS $$
BEGIN
  DELETE FROM generated_documents
  WHERE expires_at IS NOT NULL
  AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_generated_documents_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_generated_documents_timestamp
BEFORE UPDATE ON generated_documents
FOR EACH ROW
EXECUTE FUNCTION update_generated_documents_timestamp();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON generated_documents TO authenticated;
GRANT SELECT, INSERT ON document_email_log TO authenticated;
GRANT EXECUTE ON FUNCTION track_document_view TO authenticated;
GRANT EXECUTE ON FUNCTION track_document_download TO authenticated;

COMMENT ON TABLE generated_documents IS 'Stores metadata for all PDFs and documents generated by the system with links to Vercel Blob storage';
COMMENT ON TABLE document_email_log IS 'Tracks document delivery via email with open/click tracking';
