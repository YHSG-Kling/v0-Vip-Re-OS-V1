-- Enhanced Document Management System
-- Adds AI analysis, smart filing, and educational overlays

-- Add user_id for agent-uploaded documents (distinct from contact_id for client docs)
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- Enhance client_documents with AI analysis fields
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS original_filename TEXT;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS file_type TEXT;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS document_category TEXT DEFAULT 'other';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS ai_detected_type TEXT;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS ai_confidence_score DECIMAL(3,2);
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS uploaded_via TEXT DEFAULT 'portal';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'pending';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS signature_status TEXT DEFAULT 'not_required';

-- Document Analysis Table (AI-powered insights)
CREATE TABLE IF NOT EXISTS document_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  document_source TEXT NOT NULL DEFAULT 'client_documents', -- 'client_documents' or 'transaction_documents'
  ai_extracted_text TEXT,
  key_fields_extracted JSONB DEFAULT '{}',
  document_summary TEXT,
  plain_english_explanation TEXT,
  validation_status TEXT DEFAULT 'pending', -- 'pending', 'pass', 'fail', 'warning'
  validation_issues JSONB DEFAULT '[]',
  risk_flags JSONB DEFAULT '[]',
  compliance_checked BOOLEAN DEFAULT false,
  state_requirements_met BOOLEAN,
  processing_time_seconds INTEGER,
  ai_model_used TEXT,
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document Requirements (what docs are needed per stage)
CREATE TABLE IF NOT EXISTS document_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  document_type TEXT NOT NULL,
  required BOOLEAN DEFAULT true,
  description TEXT,
  why_needed TEXT,
  typical_source TEXT,
  help_article_url TEXT,
  example_url TEXT,
  required_by_date DATE,
  status TEXT DEFAULT 'missing', -- 'missing', 'uploaded', 'verified', 'approved'
  fulfilled_by_document_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Educational Overlays for Document Types
CREATE TABLE IF NOT EXISTS document_educational_overlays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL UNIQUE,
  document_name TEXT NOT NULL,
  section_name TEXT,
  plain_english_explanation TEXT NOT NULL,
  common_questions JSONB DEFAULT '[]',
  red_flags_to_watch JSONB DEFAULT '[]',
  pro_tips JSONB DEFAULT '[]',
  video_explainer_url TEXT,
  reading_time_minutes INTEGER DEFAULT 2,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- E-Signature Tracking
CREATE TABLE IF NOT EXISTS signature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  signing_order JSONB DEFAULT '[]',
  current_signer_email TEXT,
  all_parties JSONB DEFAULT '[]',
  request_status TEXT DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'expired', 'declined'
  external_signature_id TEXT, -- Dotloop, DocuSign, etc.
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  reminder_sent_count INTEGER DEFAULT 0,
  last_reminder_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signature Events (audit trail)
CREATE TABLE IF NOT EXISTS signature_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_request_id UUID REFERENCES signature_requests(id) ON DELETE CASCADE,
  signer_email TEXT NOT NULL,
  signer_name TEXT,
  event_type TEXT NOT NULL, -- 'sent', 'viewed', 'signed', 'declined', 'expired', 'reminder_sent'
  event_timestamp TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}'
);

-- Document Audit Trail
CREATE TABLE IF NOT EXISTS document_audit_trail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  document_source TEXT NOT NULL DEFAULT 'client_documents',
  action TEXT NOT NULL, -- 'uploaded', 'viewed', 'downloaded', 'moved', 'renamed', 'deleted', 'signed', 'verified', 'rejected', 'analyzed'
  performed_by UUID,
  performed_by_type TEXT, -- 'agent', 'client', 'system', 'ai'
  performed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  notes TEXT,
  metadata JSONB DEFAULT '{}'
);

-- Compliance Checks
CREATE TABLE IF NOT EXISTS document_compliance_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  document_source TEXT NOT NULL DEFAULT 'client_documents',
  check_type TEXT NOT NULL, -- 'completeness', 'accuracy', 'state_requirements', 'expiration', 'signature_validity'
  check_result TEXT NOT NULL, -- 'pass', 'fail', 'warning', 'pending'
  details TEXT,
  checked_by TEXT DEFAULT 'ai',
  checked_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default educational overlays
INSERT INTO document_educational_overlays (document_type, document_name, plain_english_explanation, common_questions, red_flags_to_watch, pro_tips) VALUES
('purchase_agreement', 'Purchase Agreement', 'This is the main contract that says you agree to buy the home at a specific price. It lists all the important details like the price, closing date, and any conditions that need to be met.', 
 '["What if I change my mind?", "Can I negotiate after signing?", "What are contingencies?"]',
 '["Unusual clauses you don''t understand", "Very short contingency periods", "Penalties that seem excessive"]',
 '["Read every page carefully", "Ask your agent to explain anything unclear", "Keep a copy for your records"]'),

('inspection_report', 'Home Inspection Report', 'A professional inspector checked the home from top to bottom and wrote down everything they found. This helps you know what repairs might be needed.',
 '["What if there are major issues?", "Can I ask the seller to fix things?", "Should I hire more specialists?"]',
 '["Foundation cracks", "Roof damage", "Electrical or plumbing issues", "Water damage or mold signs"]',
 '["Attend the inspection if possible", "Ask the inspector questions", "Get repair estimates for major issues"]'),

('appraisal', 'Home Appraisal', 'A licensed appraiser determined how much the home is worth. Your lender uses this to make sure they are not lending more than the home is worth.',
 '["What if the appraisal is low?", "Can I dispute the appraisal?", "Who pays for this?"]',
 '["Appraisal significantly below purchase price", "Condition issues noted", "Comparable sales that seem wrong"]',
 '["Review the comparable properties used", "Provide your agent with recent upgrades info", "Understand your options if it comes in low"]'),

('proof_of_funds', 'Proof of Funds', 'This document shows you have enough money for the down payment and closing costs. It is usually a bank statement or investment account statement.',
 '["Which accounts can I use?", "How recent does it need to be?", "Can I combine multiple accounts?"]',
 '["Balance lower than required amount", "Statement more than 30 days old", "Large unexplained deposits"]',
 '["Use your most recent statement", "Make sure your name is visible", "Black out account numbers for security"]'),

('closing_disclosure', 'Closing Disclosure', 'This document shows all the final costs and fees for your home purchase. By law, you must receive this at least 3 days before closing so you can review it.',
 '["Why are there so many fees?", "Can any of these be negotiated?", "What is the cash to close amount?"]',
 '["Numbers that differ significantly from your Loan Estimate", "Fees you were not told about", "Incorrect loan terms"]',
 '["Compare to your original Loan Estimate", "Ask about any fee you do not understand", "Verify the cash to close amount with your agent"]'),

('title_report', 'Title Report', 'This document shows the ownership history of the property and any claims against it like liens or easements. It ensures you will get clean ownership.',
 '["What is a lien?", "What happens if there is a title issue?", "Why do I need title insurance?"]',
 '["Outstanding liens or judgments", "Ownership disputes", "Easements that limit property use"]',
 '["Review it carefully with your agent", "Ask about any exceptions listed", "Make sure title insurance covers you"]'),

('disclosure_form', 'Seller Disclosure', 'The seller must tell you about any known problems with the property. This helps you understand what you are buying.',
 '["What if the seller hides something?", "Does this cover everything?", "Can I still do an inspection?"]',
 '["Major repairs not disclosed", "Water or flood history", "Neighbor disputes", "HOA issues"]',
 '["Always do your own inspection too", "Ask follow-up questions", "Keep this document for your records"]')
ON CONFLICT (document_type) DO NOTHING;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_document_analysis_document_id ON document_analysis(document_id);
CREATE INDEX IF NOT EXISTS idx_document_requirements_transaction ON document_requirements(transaction_id);
CREATE INDEX IF NOT EXISTS idx_document_requirements_contact ON document_requirements(contact_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_document ON signature_requests(document_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_contact ON signature_requests(contact_id);
CREATE INDEX IF NOT EXISTS idx_document_audit_trail_document ON document_audit_trail(document_id);
