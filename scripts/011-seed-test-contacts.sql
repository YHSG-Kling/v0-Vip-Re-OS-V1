-- Seed test contacts for development and testing
-- Run AFTER the users table has been seeded (scripts/005-seed-test-users.sql)

-- First, let's get the agent IDs we need
DO $$
DECLARE
  agent1_id UUID;
  agent2_id UUID;
BEGIN
  -- Get agent IDs
  SELECT id INTO agent1_id FROM users WHERE email = 'agent1@nexus.com' LIMIT 1;
  SELECT id INTO agent2_id FROM users WHERE email = 'agent2@nexus.com' LIMIT 1;

  -- Only proceed if we have agents
  IF agent1_id IS NOT NULL THEN
    -- Insert test contacts for Agent 1 (Sarah Smith)
    INSERT INTO contacts (
      first_name, last_name, email, phone, 
      contact_type, contact_persona, status, timeline, source,
      agent_id, created_by, engagement_score, intent_score, notes
    ) VALUES
    -- First-time buyer - urgent
    ('John', 'Martinez', 'john.martinez@email.com', '555-0101',
     'buyer', 'first-time-buyer', 'qualified', 'immediate', 'Zillow Lead',
     agent1_id, agent1_id, 85, 90, 'Pre-approved for $450K. Looking in Westside area.'),
    
    -- Move-up buyer
    ('Sarah', 'Chen', 'sarah.chen@email.com', '555-0102',
     'buyer', 'move-up-buyer', 'active', '1-3 months', 'Referral',
     agent1_id, agent1_id, 75, 80, 'Current home valued at $350K. Wants 4BR in good school district.'),
    
    -- Investor
    ('Michael', 'Williams', 'michael.w@investments.com', '555-0103',
     'investor', 'investor', 'nurturing', '3-6 months', 'Website',
     agent1_id, agent1_id, 60, 55, 'Looking for multi-family properties. Cash buyer.'),
    
    -- Motivated seller
    ('Emily', 'Rodriguez', 'emily.r@email.com', '555-0104',
     'seller', 'motivated-seller', 'active', 'immediate', 'Open House',
     agent1_id, agent1_id, 95, 95, 'Relocating for job. Must sell within 60 days.'),
    
    -- Downsizer
    ('Robert', 'Thompson', 'robert.t@email.com', '555-0105',
     'seller', 'downsizer', 'qualified', '3-6 months', 'Past Client',
     agent1_id, agent1_id, 70, 65, 'Kids moved out. Looking to downsize from 4BR to 2BR condo.'),
    
    -- FSBO conversion
    ('Linda', 'Davis', 'linda.d@email.com', '555-0106',
     'seller', 'fsbo', 'contacted', '1-3 months', 'Door Knock',
     agent1_id, agent1_id, 45, 40, 'FSBO for 3 weeks. Open to listing if price is right.'),
    
    -- Luxury buyer
    ('James', 'Harrison', 'james.h@luxurymail.com', '555-0107',
     'buyer', 'luxury-buyer', 'active', '1-3 months', 'Networking Event',
     agent1_id, agent1_id, 80, 85, 'Budget $2M+. Wants waterfront property with boat dock.');
    
  END IF;

  IF agent2_id IS NOT NULL THEN
    -- Insert test contacts for Agent 2 (Mike Johnson)
    INSERT INTO contacts (
      first_name, last_name, email, phone, 
      contact_type, contact_persona, status, timeline, source,
      agent_id, created_by, engagement_score, intent_score, notes
    ) VALUES
    -- Relocating buyer
    ('Patricia', 'Anderson', 'patricia.a@email.com', '555-0201',
     'buyer', 'relocating', 'qualified', 'immediate', 'Corporate Relocation',
     agent2_id, agent2_id, 90, 92, 'Moving from NYC for new job. Starts in 30 days.'),
    
    -- Expired listing
    ('David', 'Wilson', 'david.w@email.com', '555-0202',
     'seller', 'expired', 'contacted', '1-3 months', 'Expired Listing',
     agent2_id, agent2_id, 55, 50, 'Listing expired 2 weeks ago. Previous agent overpriced.'),
    
    -- Investor
    ('Jennifer', 'Taylor', 'jen.taylor@invest.com', '555-0203',
     'investor', 'investor', 'active', '1-3 months', 'LinkedIn',
     agent2_id, agent2_id, 78, 82, 'Looking for 1031 exchange property. Has $800K to reinvest.'),
    
    -- First-time buyer nurture
    ('Christopher', 'Brown', 'chris.b@email.com', '555-0204',
     'buyer', 'first-time-buyer', 'nurturing', '6-12 months', 'Facebook Ad',
     agent2_id, agent2_id, 35, 30, 'Saving for down payment. Credit score improving.'),
    
    -- Inherited property
    ('Amanda', 'Garcia', 'amanda.g@email.com', '555-0205',
     'seller', 'inherited', 'new', 'immediate', 'Probate Attorney Referral',
     agent2_id, agent2_id, 25, 70, 'Inherited property from grandparents. 3 siblings involved.');
    
  END IF;
END $$;

-- Verify contacts were created
SELECT 
  c.first_name, 
  c.last_name, 
  c.contact_type,
  c.contact_persona,
  c.status,
  c.timeline,
  u.first_name || ' ' || u.last_name as agent_name
FROM contacts c
LEFT JOIN users u ON c.agent_id = u.id
ORDER BY c.created_at DESC;
