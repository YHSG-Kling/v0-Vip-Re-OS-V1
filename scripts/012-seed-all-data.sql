-- Seed Users (including admin, agents, and contacts)
-- First, temporarily disable RLS to seed data
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE contacts DISABLE ROW LEVEL SECURITY;

-- Insert test users
INSERT INTO users (id, email, user_type, first_name, last_name, brokerage, phone, created_at)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'admin@vipos.com', 'admin', 'Admin', 'User', 'Vip-os Realty', '555-0100', NOW()),
  ('22222222-2222-2222-2222-222222222222', 'broker@vipos.com', 'broker', 'Sarah', 'Johnson', 'Vip-os Realty', '555-0101', NOW()),
  ('33333333-3333-3333-3333-333333333333', 'agent1@vipos.com', 'agent', 'Michael', 'Chen', 'Vip-os Realty', '555-0102', NOW()),
  ('44444444-4444-4444-4444-444444444444', 'agent2@vipos.com', 'agent', 'Emily', 'Rodriguez', 'Vip-os Realty', '555-0103', NOW()),
  ('55555555-5555-5555-5555-555555555555', 'lender@mortgage.com', 'lender', 'David', 'Williams', 'First National Mortgage', '555-0104', NOW()),
  ('66666666-6666-6666-6666-666666666666', 'tc@vipos.com', 'TC', 'Jessica', 'Brown', 'Vip-os Realty', '555-0105', NOW())
ON CONFLICT (email) DO NOTHING;

-- Insert test contacts
INSERT INTO contacts (id, first_name, last_name, email, phone, contact_type, status, assigned_agent_id, persona, stage, source, created_at)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'John', 'Smith', 'john.smith@email.com', '555-1001', 'buyer', 'active', '33333333-3333-3333-3333-333333333333', 'first_time_buyer', 'searching', 'website', NOW()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Mary', 'Johnson', 'mary.johnson@email.com', '555-1002', 'seller', 'active', '33333333-3333-3333-3333-333333333333', 'move_up', 'listing_prep', 'referral', NOW()),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Robert', 'Williams', 'robert.williams@email.com', '555-1003', 'buyer', 'active', '44444444-4444-4444-4444-444444444444', 'investor', 'offer_pending', 'zillow', NOW()),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Patricia', 'Brown', 'patricia.brown@email.com', '555-1004', 'seller', 'active', '44444444-4444-4444-4444-444444444444', 'downsizer', 'active_listing', 'sphere', NOW()),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'James', 'Davis', 'james.davis@email.com', '555-1005', 'buyer', 'nurturing', '33333333-3333-3333-3333-333333333333', 'luxury', 'initial_contact', 'open_house', NOW()),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Linda', 'Miller', 'linda.miller@email.com', '555-1006', 'both', 'active', '44444444-4444-4444-4444-444444444444', 'relocator', 'under_contract', 'past_client', NOW()),
  ('11111111-aaaa-bbbb-cccc-dddddddddddd', 'William', 'Wilson', 'william.wilson@email.com', '555-1007', 'buyer', 'closed', '33333333-3333-3333-3333-333333333333', 'first_time_buyer', 'closed', 'website', NOW() - INTERVAL '30 days'),
  ('22222222-aaaa-bbbb-cccc-dddddddddddd', 'Elizabeth', 'Moore', 'elizabeth.moore@email.com', '555-1008', 'seller', 'active', '33333333-3333-3333-3333-333333333333', 'empty_nester', 'listing_prep', 'referral', NOW()),
  ('33333333-aaaa-bbbb-cccc-dddddddddddd', 'Charles', 'Taylor', 'charles.taylor@email.com', '555-1009', 'buyer', 'active', '44444444-4444-4444-4444-444444444444', 'investor', 'searching', 'social_media', NOW()),
  ('44444444-aaaa-bbbb-cccc-dddddddddddd', 'Barbara', 'Anderson', 'barbara.anderson@email.com', '555-1010', 'both', 'nurturing', '33333333-3333-3333-3333-333333333333', 'move_up', 'initial_contact', 'cold_call', NOW())
ON CONFLICT (id) DO NOTHING;

-- Re-enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Create permissive RLS policies for development (allow all reads)
DROP POLICY IF EXISTS "Allow public read access to users" ON users;
CREATE POLICY "Allow public read access to users" ON users FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public read access to contacts" ON contacts;
CREATE POLICY "Allow public read access to contacts" ON contacts FOR SELECT USING (true);

-- Allow inserts/updates for authenticated and anon users during development
DROP POLICY IF EXISTS "Allow all inserts to users" ON users;
CREATE POLICY "Allow all inserts to users" ON users FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all updates to users" ON users;
CREATE POLICY "Allow all updates to users" ON users FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow all inserts to contacts" ON contacts;
CREATE POLICY "Allow all inserts to contacts" ON contacts FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all updates to contacts" ON contacts;
CREATE POLICY "Allow all updates to contacts" ON contacts FOR UPDATE USING (true);
