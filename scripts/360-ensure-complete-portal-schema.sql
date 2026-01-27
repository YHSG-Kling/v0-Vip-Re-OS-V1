-- =====================================================
-- COMPLETE PORTAL SCHEMA - Ensures all required tables exist
-- =====================================================

-- 1. Add missing columns to existing tables
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS listing_id UUID;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_id UUID;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contact_id UUID;
ALTER TABLE transaction_milestones ADD COLUMN IF NOT EXISTS contact_id UUID;
ALTER TABLE showing_requests ADD COLUMN IF NOT EXISTS property_address TEXT;
ALTER TABLE saved_properties ADD COLUMN IF NOT EXISTS property_address TEXT;
ALTER TABLE saved_properties ADD COLUMN IF NOT EXISTS property_data JSONB DEFAULT '{}';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS property_address TEXT;

-- Add status column to client_documents if missing
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS url TEXT;

-- 2. Create indexes
CREATE INDEX IF NOT EXISTS idx_contacts_listing ON contacts(listing_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_contact ON listings(contact_id);
CREATE INDEX IF NOT EXISTS idx_transactions_contact ON transactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_milestones_contact ON transaction_milestones(contact_id);

-- 3. Delete existing demo data to avoid conflicts
DELETE FROM client_documents WHERE contact_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM client_portal_messages WHERE contact_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM transaction_milestones WHERE contact_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM transactions WHERE contact_id = '00000000-0000-0000-0000-000000000001';

-- 4. Demo documents for first-time buyer
INSERT INTO client_documents (contact_id, document_name, document_url, document_type, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Pre-Approval Letter', '/documents/pre-approval.pdf', 'loan_doc', NOW() - INTERVAL '14 days'),
  ('00000000-0000-0000-0000-000000000001', 'Purchase Agreement', '/documents/purchase-agreement.pdf', 'contract', NOW() - INTERVAL '3 days'),
  ('00000000-0000-0000-0000-000000000001', 'Home Inspection Report', '/documents/inspection-report.pdf', 'inspection', NOW() - INTERVAL '7 days'),
  ('00000000-0000-0000-0000-000000000001', 'Proof of Funds', '/documents/proof-of-funds.pdf', 'income', NOW() - INTERVAL '10 days');

-- 5. Demo messages for first-time buyer
INSERT INTO client_portal_messages (contact_id, message_type, title, content, is_read, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'welcome', 'Welcome to Your Journey!', 'Welcome to your homebuying journey! I''m excited to help you find your perfect first home.', true, NOW() - INTERVAL '7 days'),
  ('00000000-0000-0000-0000-000000000001', 'milestone', 'Pre-Approval Complete!', 'Great news! Your pre-approval came through. You''re approved for up to $425,000!', true, NOW() - INTERVAL '5 days'),
  ('00000000-0000-0000-0000-000000000001', 'custom', 'New Listings Found', 'I found 3 new listings that match your criteria. Check them out in the Properties tab!', false, NOW() - INTERVAL '1 day');

-- 6. Demo transaction for first-time buyer
INSERT INTO transactions (id, contact_id, deal_name, status, deal_type, property_address, purchase_price, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000001',
  'Sarah Chen - First Home Purchase',
  'under_contract',
  'buyer',
  '123 Oak Lane, Austin, TX 78701',
  385000,
  NOW() - INTERVAL '14 days'
);

-- Using only basic columns that exist: milestone_name, milestone_date, status, notes, contact_id
-- 7. Demo milestones for first-time buyer - using basic columns from script 020
INSERT INTO transaction_milestones (transaction_id, contact_id, milestone_name, milestone_date, status, notes)
VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Pre-Approval', CURRENT_DATE - 10, 'completed', 'Get pre-approved for mortgage'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Home Search', CURRENT_DATE - 5, 'completed', 'Find and tour potential homes'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Make Offer', CURRENT_DATE - 3, 'completed', 'Submit offer on chosen property'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Home Inspection', CURRENT_DATE + 2, 'pending', 'Complete home inspection'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Appraisal', CURRENT_DATE + 7, 'pending', 'Property appraisal by lender'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Final Walkthrough', CURRENT_DATE + 21, 'pending', 'Final property walkthrough'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Closing', CURRENT_DATE + 25, 'pending', 'Sign documents and get keys!');
