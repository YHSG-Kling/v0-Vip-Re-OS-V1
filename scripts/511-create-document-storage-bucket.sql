-- Create storage bucket for client documents
-- Note: This needs to be run via Supabase Dashboard or supabase CLI

-- Storage bucket creation (run in Supabase SQL Editor)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-documents',
  'client-documents',
  false,
  10485760, -- 10MB limit
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[]
) ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage policies for authenticated users
CREATE POLICY "Users can upload documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'client-documents');

CREATE POLICY "Users can view own documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'client-documents');

CREATE POLICY "Users can delete own documents" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'client-documents');

-- RLS for client_documents table
ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients can view own documents" ON client_documents
  FOR SELECT USING (
    contact_id::text = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM transactions t 
      WHERE t.id = client_documents.transaction_id 
      AND (t.contact_id::text = auth.uid()::text OR t.agent_id::text = auth.uid()::text)
    )
  );

CREATE POLICY "Clients can insert own documents" ON client_documents
  FOR INSERT WITH CHECK (
    contact_id::text = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM agents WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Agents can view transaction documents" ON client_documents
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM agents WHERE user_id = auth.uid()
    )
  );
