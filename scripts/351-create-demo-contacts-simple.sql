-- ============================================================================
-- CREATE DEMO CONTACTS FOR ALL PERSONAS (SIMPLIFIED)
-- ============================================================================
-- Creates realistic demo contacts for each persona type
-- These allow the demo login flow to work with real portal URLs

-- First, ensure we have the required columns
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_persona TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS demo_account BOOLEAN DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS budget_min INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS budget_max INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timeline TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields JSONB;

-- Create index for demo lookups
CREATE INDEX IF NOT EXISTS idx_contacts_demo_persona ON contacts(demo_account, contact_persona);

-- ============================================================================
-- BUYER PERSONAS
-- ============================================================================

-- First Time Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Sarah', 'Mitchell', 'sarah.mitchell@demo.example.com', '(555) 123-4501',
  'first_time_buyer', 'buyer', 'active', 250000, 400000, '90_days', true,
  '["first-time-buyer", "pre-approved", "demo"]'::jsonb,
  '{"down_payment_saved": 45000, "pre_approval_amount": 380000, "preferred_areas": ["Midtown", "East Side"]}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Military Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'Marcus', 'Thompson', 'marcus.thompson@demo.example.com', '(555) 123-4502',
  'military_buyer', 'buyer', 'active', 300000, 450000, '60_days', true,
  '["military", "va-loan", "pcs-move", "demo"]'::jsonb,
  '{"military_branch": "Army", "rank": "Captain", "va_entitlement": "Full", "bah_amount": 2400}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Luxury Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  'Victoria', 'Sterling', 'victoria.sterling@demo.example.com', '(555) 123-4503',
  'luxury_buyer', 'buyer', 'active', 1500000, 3000000, '6_months', true,
  '["luxury", "cash-buyer", "demo"]'::jsonb,
  '{"payment_method": "Cash", "privacy_requirements": "High", "concierge_services": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Investor
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000004',
  'David', 'Chen', 'david.chen@demo.example.com', '(555) 123-4504',
  'investor', 'investor', 'active', 200000, 800000, 'immediate', true,
  '["investor", "multi-family", "demo"]'::jsonb,
  '{"investment_strategy": "Buy and Hold", "target_cap_rate": 7.5, "portfolio_size": 12}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Relocating Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000005',
  'Jennifer', 'Martinez', 'jennifer.martinez@demo.example.com', '(555) 123-4505',
  'relocating', 'buyer', 'active', 400000, 600000, '60_days', true,
  '["relocation", "corporate-move", "demo"]'::jsonb,
  '{"relocating_from": "Seattle, WA", "relocation_reason": "Job Transfer", "relocation_package": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Upsizing Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000006',
  'Michael', 'Johnson', 'michael.johnson@demo.example.com', '(555) 123-4506',
  'upsizers', 'buyer', 'active', 500000, 750000, '90_days', true,
  '["upsizing", "growing-family", "demo"]'::jsonb,
  '{"current_home_value": 350000, "reason_for_upsizing": "Growing family", "must_have_bedrooms": 5}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- ============================================================================
-- SELLER PERSONAS
-- ============================================================================

-- First Time Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000007',
  'Amanda', 'Roberts', 'amanda.roberts@demo.example.com', '(555) 123-4507',
  'first_time_seller', 'seller', 'active', true,
  '["first-time-seller", "needs-guidance", "demo"]'::jsonb,
  '{"property_address": "456 Oak Lane", "years_owned": 5, "estimated_value": 385000}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Motivated Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000008',
  'Robert', 'Wilson', 'robert.wilson@demo.example.com', '(555) 123-4508',
  'motivated_seller', 'seller', 'active', true,
  '["motivated", "quick-sale", "demo"]'::jsonb,
  '{"property_address": "789 Elm Street", "urgency_level": "High", "price_flexibility": "10-15%"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Luxury Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000009',
  'Elizabeth', 'Ashworth', 'elizabeth.ashworth@demo.example.com', '(555) 123-4509',
  'luxury_seller', 'seller', 'active', true,
  '["luxury", "high-end", "demo"]'::jsonb,
  '{"property_address": "1 Estate Drive", "list_price": 2850000, "privacy_level": "Maximum"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Remote Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  'Christopher', 'Lee', 'christopher.lee@demo.example.com', '(555) 123-4510',
  'remote_seller', 'seller', 'active', true,
  '["remote-seller", "out-of-state", "demo"]'::jsonb,
  '{"property_address": "321 Pine Avenue", "current_location": "London, UK", "timezone": "GMT"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- FSBO
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000011',
  'Thomas', 'Anderson', 'thomas.anderson@demo.example.com', '(555) 123-4511',
  'fsbo', 'seller', 'active', true,
  '["fsbo", "considering-agent", "demo"]'::jsonb,
  '{"property_address": "555 Maple Court", "days_on_market_fsbo": 45, "asking_price": 425000}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Expired Listing
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000012',
  'Patricia', 'Garcia', 'patricia.garcia@demo.example.com', '(555) 123-4512',
  'expired', 'seller', 'active', true,
  '["expired", "relisting", "demo"]'::jsonb,
  '{"property_address": "888 Cedar Boulevard", "previous_list_price": 475000, "days_on_market": 180}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- ============================================================================
-- LIFE SITUATION PERSONAS
-- ============================================================================

-- Divorce
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000013',
  'Michelle', 'Taylor', 'michelle.taylor@demo.example.com', '(555) 123-4513',
  'divorce', 'seller', 'active', true,
  '["divorce", "confidential", "demo"]'::jsonb,
  '{"property_address": "222 Family Lane", "situation": "Amicable divorce", "both_parties_agree_to_sell": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Probate
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000014',
  'William', 'Harrison', 'william.harrison@demo.example.com', '(555) 123-4514',
  'probate', 'seller', 'active', true,
  '["probate", "estate-sale", "demo"]'::jsonb,
  '{"property_address": "100 Heritage Court", "relationship_to_deceased": "Son", "probate_status": "Letters issued"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Senior
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000015',
  'Dorothy', 'Williams', 'dorothy.williams@demo.example.com', '(555) 123-4515',
  'senior', 'seller', 'active', true,
  '["senior", "downsizing", "demo"]'::jsonb,
  '{"property_address": "50 Memory Lane", "years_in_home": 42, "memory_video_requested": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- Empty Nester / Downsizing
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000016',
  'Richard', 'Brown', 'richard.brown@demo.example.com', '(555) 123-4516',
  'empty_nester', 'seller', 'active', true,
  '["empty-nester", "downsizing", "demo"]'::jsonb,
  '{"current_sqft": 3200, "desired_sqft": 1600, "reason": "Kids graduated, time to simplify"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, contact_persona = EXCLUDED.contact_persona, demo_account = true;

-- ============================================================================
-- LOOKUP TABLE FOR DEMO ROUTING
-- ============================================================================

CREATE TABLE IF NOT EXISTS demo_persona_contacts (
  persona TEXT PRIMARY KEY,
  contact_id UUID REFERENCES contacts(id),
  display_name TEXT,
  description TEXT
);

INSERT INTO demo_persona_contacts (persona, contact_id, display_name, description)
VALUES
  ('first_time_buyer', '00000000-0000-0000-0000-000000000001', 'Sarah Mitchell', 'First-time homebuyer, pre-approved'),
  ('military_buyer', '00000000-0000-0000-0000-000000000002', 'Marcus Thompson', 'Army Captain, VA loan'),
  ('luxury_buyer', '00000000-0000-0000-0000-000000000003', 'Victoria Sterling', 'Cash buyer, $1.5-3M budget'),
  ('investor', '00000000-0000-0000-0000-000000000004', 'David Chen', 'Multi-family investor'),
  ('relocating', '00000000-0000-0000-0000-000000000005', 'Jennifer Martinez', 'Corporate relocation'),
  ('upsizers', '00000000-0000-0000-0000-000000000006', 'Michael Johnson', 'Growing family'),
  ('first_time_seller', '00000000-0000-0000-0000-000000000007', 'Amanda Roberts', 'First time selling'),
  ('motivated_seller', '00000000-0000-0000-0000-000000000008', 'Robert Wilson', 'Quick sale needed'),
  ('luxury_seller', '00000000-0000-0000-0000-000000000009', 'Elizabeth Ashworth', '$2.85M estate'),
  ('remote_seller', '00000000-0000-0000-0000-000000000010', 'Christopher Lee', 'Selling from London'),
  ('fsbo', '00000000-0000-0000-0000-000000000011', 'Thomas Anderson', 'FSBO for 45 days'),
  ('expired', '00000000-0000-0000-0000-000000000012', 'Patricia Garcia', 'Expired listing'),
  ('divorce', '00000000-0000-0000-0000-000000000013', 'Michelle Taylor', 'Amicable divorce'),
  ('probate', '00000000-0000-0000-0000-000000000014', 'William Harrison', 'Estate sale'),
  ('senior', '00000000-0000-0000-0000-000000000015', 'Dorothy Williams', '42 years in home'),
  ('empty_nester', '00000000-0000-0000-0000-000000000016', 'Richard Brown', 'Downsizing')
ON CONFLICT (persona) DO UPDATE SET
  contact_id = EXCLUDED.contact_id,
  display_name = EXCLUDED.display_name;

-- Grant access
ALTER TABLE demo_persona_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read demo contacts" ON demo_persona_contacts;
CREATE POLICY "Public read demo contacts" ON demo_persona_contacts FOR SELECT USING (true);
