-- ============================================================================
-- CREATE DEMO CONTACTS FOR ALL PERSONAS
-- ============================================================================
-- Creates realistic demo contacts for each persona type
-- These allow the demo login flow to work with real portal URLs

-- First, ensure we have the contact_persona column
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_persona TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS demo_account BOOLEAN DEFAULT false;

-- Create index for demo lookups
CREATE INDEX IF NOT EXISTS idx_contacts_demo_persona ON contacts(demo_account, contact_persona);

-- Insert demo contacts for all 15+ personas
-- Using fixed UUIDs so they're predictable for routing

-- ============================================================================
-- BUYER PERSONAS
-- ============================================================================

-- First Time Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Sarah',
  'Mitchell',
  'sarah.mitchell@demo.example.com',
  '(555) 123-4501',
  'first_time_buyer',
  'buyer',
  'active',
  'searching',
  250000,
  400000,
  '90_days',
  true,
  '["first-time-buyer", "pre-approved", "demo"]'::jsonb,
  '{"down_payment_saved": 45000, "pre_approval_amount": 380000, "preferred_areas": ["Midtown", "East Side"], "must_haves": ["3+ bedrooms", "Garage", "Good schools"], "deal_breakers": ["No HOA over $300", "No flood zone"]}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Military Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'Marcus',
  'Thompson',
  'marcus.thompson@demo.example.com',
  '(555) 123-4502',
  'military_buyer',
  'buyer',
  'active',
  'searching',
  300000,
  450000,
  '60_days',
  true,
  '["military", "va-loan", "pcs-move", "demo"]'::jsonb,
  '{"military_branch": "Army", "rank": "Captain", "pcs_date": "2024-03-15", "va_entitlement": "Full", "bah_amount": 2400, "current_base": "Fort Bragg", "new_duty_station": "Fort Hood"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Luxury Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  'Victoria',
  'Sterling',
  'victoria.sterling@demo.example.com',
  '(555) 123-4503',
  'luxury_buyer',
  'buyer',
  'active',
  'searching',
  1500000,
  3000000,
  '6_months',
  true,
  '["luxury", "cash-buyer", "investment", "demo"]'::jsonb,
  '{"payment_method": "Cash", "current_residence": "Park Avenue Penthouse", "desired_features": ["Wine cellar", "Home theater", "Pool", "Smart home"], "privacy_requirements": "High", "concierge_services": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Investor
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000004',
  'David',
  'Chen',
  'david.chen@demo.example.com',
  '(555) 123-4504',
  'investor',
  'investor',
  'active',
  'searching',
  200000,
  800000,
  'immediate',
  true,
  '["investor", "multi-family", "cash-flow", "demo"]'::jsonb,
  '{"investment_strategy": "Buy and Hold", "target_cap_rate": 7.5, "portfolio_size": 12, "preferred_property_types": ["Multi-family", "Duplex", "Triplex"], "target_markets": ["Downtown", "University District"], "financing": "Conventional 25% down"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Relocating Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000005',
  'Jennifer',
  'Martinez',
  'jennifer.martinez@demo.example.com',
  '(555) 123-4505',
  'relocating',
  'buyer',
  'active',
  'searching',
  400000,
  600000,
  '60_days',
  true,
  '["relocation", "corporate-move", "remote-buyer", "demo"]'::jsonb,
  '{"relocating_from": "Seattle, WA", "relocation_reason": "Job Transfer", "employer": "TechCorp Inc", "relocation_package": true, "start_date": "2024-04-01", "family_size": 4, "school_age_children": 2, "commute_to": "Downtown Tech District"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Upsizing Buyer
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, budget_min, budget_max, timeline, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000006',
  'Michael',
  'Johnson',
  'michael.johnson@demo.example.com',
  '(555) 123-4506',
  'upsizers',
  'buyer',
  'active',
  'searching',
  500000,
  750000,
  '90_days',
  true,
  '["upsizing", "growing-family", "sell-buy", "demo"]'::jsonb,
  '{"current_home_value": 350000, "current_home_equity": 180000, "reason_for_upsizing": "Growing family - expecting twins", "current_sqft": 1400, "desired_sqft": 2800, "must_have_bedrooms": 5, "school_district_priority": "High"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- ============================================================================
-- SELLER PERSONAS
-- ============================================================================

-- First Time Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000007',
  'Amanda',
  'Roberts',
  'amanda.roberts@demo.example.com',
  '(555) 123-4507',
  'first_time_seller',
  'seller',
  'active',
  'pre_listing',
  true,
  '["first-time-seller", "needs-guidance", "demo"]'::jsonb,
  '{"property_address": "456 Oak Lane", "years_owned": 5, "estimated_value": 385000, "mortgage_balance": 220000, "reason_for_selling": "Job relocation", "timeline_to_sell": "90 days", "next_steps_needed": ["Home valuation", "Staging consultation", "Photography"]}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Motivated Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000008',
  'Robert',
  'Wilson',
  'robert.wilson@demo.example.com',
  '(555) 123-4508',
  'motivated_seller',
  'seller',
  'active',
  'active_listing',
  true,
  '["motivated", "quick-sale", "flexible-terms", "demo"]'::jsonb,
  '{"property_address": "789 Elm Street", "urgency_level": "High", "reason_for_urgency": "Job loss - need to relocate", "willing_to_consider": ["Cash offers", "Investor offers", "Quick close"], "price_flexibility": "10-15% below market", "move_out_flexibility": "Immediate if needed"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Luxury Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000009',
  'Elizabeth',
  'Ashworth',
  'elizabeth.ashworth@demo.example.com',
  '(555) 123-4509',
  'luxury_seller',
  'seller',
  'active',
  'active_listing',
  true,
  '["luxury", "high-end", "privacy-required", "demo"]'::jsonb,
  '{"property_address": "1 Estate Drive", "list_price": 2850000, "property_features": ["6 bedrooms", "Wine cellar", "Pool", "Guest house", "3-car garage"], "marketing_requirements": ["Professional video", "Drone footage", "Virtual tour", "Private showings only"], "privacy_level": "Maximum - no public open houses"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Remote Seller
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  'Christopher',
  'Lee',
  'christopher.lee@demo.example.com',
  '(555) 123-4510',
  'remote_seller',
  'seller',
  'active',
  'pre_listing',
  true,
  '["remote-seller", "out-of-state", "virtual-management", "demo"]'::jsonb,
  '{"property_address": "321 Pine Avenue", "current_location": "London, UK", "timezone": "GMT", "preferred_contact_method": "Email/Video call", "property_access": "Lockbox + Property manager", "decision_makers": ["Christopher Lee", "Susan Lee (spouse)"], "power_of_attorney": false}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- FSBO (For Sale By Owner)
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000011',
  'Thomas',
  'Anderson',
  'thomas.anderson@demo.example.com',
  '(555) 123-4511',
  'fsbo',
  'seller',
  'active',
  'pre_listing',
  true,
  '["fsbo", "considering-agent", "price-sensitive", "demo"]'::jsonb,
  '{"property_address": "555 Maple Court", "days_on_market_fsbo": 45, "asking_price": 425000, "offers_received": 1, "reason_for_fsbo": "Save on commission", "challenges_faced": ["Low showings", "Unqualified buyers", "Paperwork complexity"], "open_to_listing": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Expired Listing
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000012',
  'Patricia',
  'Garcia',
  'patricia.garcia@demo.example.com',
  '(555) 123-4512',
  'expired',
  'seller',
  'active',
  'pre_listing',
  true,
  '["expired", "relisting", "price-adjustment", "demo"]'::jsonb,
  '{"property_address": "888 Cedar Boulevard", "previous_list_price": 475000, "days_on_market": 180, "previous_agent": "Other Brokerage", "reason_expired": "Overpriced + Poor marketing", "feedback_from_showings": ["Price too high", "Dated kitchen", "Needs staging"], "willing_to_adjust_price": true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- ============================================================================
-- LIFE SITUATION PERSONAS
-- ============================================================================

-- Divorce
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000013',
  'Michelle',
  'Taylor',
  'michelle.taylor@demo.example.com',
  '(555) 123-4513',
  'divorce',
  'seller',
  'active',
  'pre_listing',
  true,
  '["divorce", "confidential", "neutral-party", "demo"]'::jsonb,
  '{"property_address": "222 Family Lane", "situation": "Amicable divorce", "both_parties_agree_to_sell": true, "court_ordered_sale": false, "divorce_attorney": "Smith & Associates", "timeline_requirement": "Finalize within 90 days", "communication_preference": "Separate communications to each party", "other_party_contact": "Mark Taylor"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Probate
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000014',
  'William',
  'Harrison',
  'william.harrison@demo.example.com',
  '(555) 123-4514',
  'probate',
  'seller',
  'active',
  'pre_listing',
  true,
  '["probate", "estate-sale", "compassionate", "demo"]'::jsonb,
  '{"property_address": "100 Heritage Court", "relationship_to_deceased": "Son", "deceased_name": "Margaret Harrison", "probate_status": "Letters testamentary issued", "estate_attorney": "Johnson Legal Group", "other_heirs": ["Susan Harrison (sister)", "James Harrison (brother)"], "property_condition": "Needs cleanout - 50 years of belongings", "emotional_attachment": "High - childhood home"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Senior / Empty Nester
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000015',
  'Dorothy',
  'Williams',
  'dorothy.williams@demo.example.com',
  '(555) 123-4515',
  'senior',
  'seller',
  'active',
  'pre_listing',
  true,
  '["senior", "downsizing", "memory-video", "demo"]'::jsonb,
  '{"property_address": "50 Memory Lane", "years_in_home": 42, "reason_for_moving": "Downsizing - kids have moved out, house too big", "next_destination": "55+ community or condo", "mobility_concerns": "Stairs becoming difficult", "help_needed": ["Decluttering", "Estate sale coordination", "Moving assistance"], "memory_video_requested": true, "family_involvement": "Daughter helping with decisions"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- Downsizing / Empty Nester
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_persona, contact_type, status, stage, demo_account, tags, custom_fields)
VALUES (
  '00000000-0000-0000-0000-000000000016',
  'Richard',
  'Brown',
  'richard.brown@demo.example.com',
  '(555) 123-4516',
  'empty_nester',
  'seller',
  'active',
  'searching',
  true,
  '["empty-nester", "downsizing", "buy-sell", "demo"]'::jsonb,
  '{"current_property": "4-bedroom colonial", "current_sqft": 3200, "desired_sqft": 1600, "reason": "Kids graduated college, time to simplify", "preferences": ["Single story", "Low maintenance", "Near grandchildren"], "current_home_value": 650000, "target_purchase_price": 400000}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  contact_persona = EXCLUDED.contact_persona,
  demo_account = true;

-- ============================================================================
-- CREATE DEMO LISTINGS FOR SELLER PERSONAS
-- ============================================================================

-- Luxury Seller Listing
INSERT INTO listings (id, seller_id, address, city, state, zip, list_price, status, bedrooms, bathrooms, square_feet, lot_size, year_built, property_type, description, features, photos, virtual_tour_url, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000009',
  '00000000-0000-0000-0000-000000000009',
  '1 Estate Drive',
  'Beverly Hills',
  'CA',
  '90210',
  2850000,
  'active',
  6,
  7,
  8500,
  '1.2 acres',
  2018,
  'Single Family',
  'Stunning modern estate with panoramic views, featuring a resort-style pool, wine cellar, home theater, and guest house.',
  '["Pool", "Wine Cellar", "Home Theater", "Smart Home", "Guest House", "3-Car Garage", "Gated Entry"]'::jsonb,
  '["/demo/luxury-estate-1.jpg", "/demo/luxury-estate-2.jpg", "/demo/luxury-estate-3.jpg"]'::jsonb,
  'https://my.matterport.com/demo-luxury',
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  seller_id = EXCLUDED.seller_id,
  list_price = EXCLUDED.list_price;

-- Motivated Seller Listing
INSERT INTO listings (id, seller_id, address, city, state, zip, list_price, status, bedrooms, bathrooms, square_feet, year_built, property_type, description, days_on_market, price_drops, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000008',
  '00000000-0000-0000-0000-000000000008',
  '789 Elm Street',
  'Austin',
  'TX',
  '78701',
  315000,
  'active',
  3,
  2,
  1850,
  2005,
  'Single Family',
  'Well-maintained home in desirable neighborhood. Seller motivated - priced to sell quickly!',
  28,
  1,
  NOW() - INTERVAL '28 days'
)
ON CONFLICT (id) DO UPDATE SET
  seller_id = EXCLUDED.seller_id,
  list_price = EXCLUDED.list_price;

-- ============================================================================
-- CREATE DEMO TRANSACTIONS
-- ============================================================================

-- First Time Buyer - Under Contract
INSERT INTO transactions (id, contact_id, property_address, transaction_type, status, stage, purchase_price, earnest_money, closing_date, created_at)
VALUES (
  '00000000-0000-0000-2000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '123 Dream Home Lane, Austin, TX 78701',
  'purchase',
  'active',
  'under_contract',
  375000,
  7500,
  NOW() + INTERVAL '30 days',
  NOW() - INTERVAL '15 days'
)
ON CONFLICT (id) DO UPDATE SET
  contact_id = EXCLUDED.contact_id;

-- ============================================================================
-- CREATE DEMO MILESTONES FOR FIRST TIME BUYER
-- ============================================================================

INSERT INTO transaction_milestones (transaction_id, milestone_name, milestone_type, status, due_date, completed_at, notes, sort_order)
VALUES 
  ('00000000-0000-0000-2000-000000000001', 'Contract Accepted', 'contract', 'completed', NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days', 'Offer accepted at $375,000', 1),
  ('00000000-0000-0000-2000-000000000001', 'Earnest Money Deposited', 'earnest_money', 'completed', NOW() - INTERVAL '12 days', NOW() - INTERVAL '13 days', '$7,500 deposited with title company', 2),
  ('00000000-0000-0000-2000-000000000001', 'Home Inspection', 'inspection', 'completed', NOW() - INTERVAL '8 days', NOW() - INTERVAL '9 days', 'Minor issues found - repairs negotiated', 3),
  ('00000000-0000-0000-2000-000000000001', 'Appraisal Ordered', 'appraisal', 'completed', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days', 'Appraisal scheduled for next week', 4),
  ('00000000-0000-0000-2000-000000000001', 'Appraisal Completed', 'appraisal', 'in_progress', NOW() + INTERVAL '2 days', NULL, 'Appraiser visiting property', 5),
  ('00000000-0000-0000-2000-000000000001', 'Loan Approval', 'financing', 'pending', NOW() + INTERVAL '10 days', NULL, 'Waiting on underwriting', 6),
  ('00000000-0000-0000-2000-000000000001', 'Final Walkthrough', 'walkthrough', 'pending', NOW() + INTERVAL '28 days', NULL, 'Schedule 1-2 days before closing', 7),
  ('00000000-0000-0000-2000-000000000001', 'Closing Day', 'closing', 'pending', NOW() + INTERVAL '30 days', NULL, 'Bring ID and certified funds', 8)
ON CONFLICT DO NOTHING;

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
  ('first_time_buyer', '00000000-0000-0000-0000-000000000001', 'Sarah Mitchell', 'First-time homebuyer, pre-approved, searching in $250-400K range'),
  ('military_buyer', '00000000-0000-0000-0000-000000000002', 'Marcus Thompson', 'Army Captain, VA loan, PCS move to Fort Hood'),
  ('luxury_buyer', '00000000-0000-0000-0000-000000000003', 'Victoria Sterling', 'Cash buyer, $1.5-3M budget, high privacy needs'),
  ('investor', '00000000-0000-0000-0000-000000000004', 'David Chen', 'Multi-family investor, 12-property portfolio'),
  ('relocating', '00000000-0000-0000-0000-000000000005', 'Jennifer Martinez', 'Corporate relocation from Seattle'),
  ('upsizers', '00000000-0000-0000-0000-000000000006', 'Michael Johnson', 'Growing family, needs more space'),
  ('first_time_seller', '00000000-0000-0000-0000-000000000007', 'Amanda Roberts', 'First time selling, needs guidance'),
  ('motivated_seller', '00000000-0000-0000-0000-000000000008', 'Robert Wilson', 'Quick sale needed, flexible terms'),
  ('luxury_seller', '00000000-0000-0000-0000-000000000009', 'Elizabeth Ashworth', '$2.85M estate, privacy required'),
  ('remote_seller', '00000000-0000-0000-0000-000000000010', 'Christopher Lee', 'Selling from London, virtual management'),
  ('fsbo', '00000000-0000-0000-0000-000000000011', 'Thomas Anderson', 'FSBO for 45 days, considering agent'),
  ('expired', '00000000-0000-0000-0000-000000000012', 'Patricia Garcia', 'Expired after 180 days, relisting'),
  ('divorce', '00000000-0000-0000-0000-000000000013', 'Michelle Taylor', 'Amicable divorce, neutral party needed'),
  ('probate', '00000000-0000-0000-0000-000000000014', 'William Harrison', 'Estate sale, compassionate approach'),
  ('senior', '00000000-0000-0000-0000-000000000015', 'Dorothy Williams', '42 years in home, memory video requested'),
  ('empty_nester', '00000000-0000-0000-0000-000000000016', 'Richard Brown', 'Downsizing from 4BR to condo')
ON CONFLICT (persona) DO UPDATE SET
  contact_id = EXCLUDED.contact_id,
  display_name = EXCLUDED.display_name;

-- Grant access
ALTER TABLE demo_persona_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all access to demo_persona_contacts" ON demo_persona_contacts;
CREATE POLICY "Allow all access to demo_persona_contacts" ON demo_persona_contacts FOR ALL USING (true);
