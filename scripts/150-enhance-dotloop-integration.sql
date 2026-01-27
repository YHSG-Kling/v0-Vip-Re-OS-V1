-- Enhance transactions table for Dotloop
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dotloop_sync_enabled BOOLEAN DEFAULT true;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_dotloop_sync TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transactions_dotloop ON transactions(dotloop_loop_id);

-- Enhance client_documents table for Dotloop
CREATE TABLE IF NOT EXISTS client_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  transaction_id UUID REFERENCES transactions(id),
  listing_id UUID REFERENCES listings(id),
  dotloop_loop_id TEXT,
  dotloop_document_id TEXT,
  dotloop_folder_name TEXT,
  document_name TEXT NOT NULL,
  document_type TEXT, -- contract, disclosure, inspection, appraisal, loan_doc, closing_doc
  status TEXT DEFAULT 'pending_signature', -- pending_signature, signed, completed, rejected
  url TEXT,
  signed_at TIMESTAMPTZ,
  signers JSONB, -- [{name, email, signed_at}]
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_docs_contact ON client_documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_client_docs_transaction ON client_documents(transaction_id);
CREATE INDEX IF NOT EXISTS idx_client_docs_dotloop ON client_documents(dotloop_loop_id);
CREATE INDEX IF NOT EXISTS idx_client_docs_dotloop_doc ON client_documents(dotloop_document_id);

-- RLS policies for client_documents
ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see their own brokerage documents"
  ON client_documents FOR SELECT
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

CREATE POLICY "Agents can insert documents"
  ON client_documents FOR INSERT
  WITH CHECK (
    contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

CREATE POLICY "Agents can update their documents"
  ON client_documents FOR UPDATE
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_client_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_documents_updated_at
  BEFORE UPDATE ON client_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_client_documents_updated_at();
