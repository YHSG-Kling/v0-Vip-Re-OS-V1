-- ============================================================================
-- COMPLETE DEMO DATA FOR ALL 16 PERSONAS
-- ============================================================================
-- This script adds realistic demo data for each persona including:
-- - Transactions with milestones (including deal_name which is required)
-- - Showings
-- - Documents
-- - Messages
-- - Saved properties (for buyers)
-- - Offers
-- ============================================================================
-- Status values must be: 'pending', 'completed', or 'overdue' per database constraint

-- Military Buyer Demo Data (00000000-0000-0000-0000-000000000002)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000002',
  'Rodriguez VA Home Purchase',
  '00000000-0000-0000-0000-000000000002',
  '456 Base Housing Rd, Norfolk, VA 23505',
  'under_contract',
  'buyer',
  NOW() - INTERVAL '14 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000201', '00000000-0000-0000-1000-000000000002', 'VA Loan Pre-Approval', NOW() - INTERVAL '30 days', 'completed', 'COE verified, full entitlement available'),
  ('00000000-0000-0000-2000-000000000202', '00000000-0000-0000-1000-000000000002', 'Home Search Started', NOW() - INTERVAL '21 days', 'completed', 'Focus on properties near base'),
  ('00000000-0000-0000-2000-000000000203', '00000000-0000-0000-1000-000000000002', 'Offer Submitted', NOW() - INTERVAL '14 days', 'completed', 'VA amendatory clause included'),
  ('00000000-0000-0000-2000-000000000204', '00000000-0000-0000-1000-000000000002', 'Under Contract', NOW() - INTERVAL '12 days', 'completed', 'Seller accepted offer'),
  ('00000000-0000-0000-2000-000000000205', '00000000-0000-0000-1000-000000000002', 'VA Appraisal Ordered', NOW() - INTERVAL '10 days', 'completed', 'VA appraiser assigned'),
  ('00000000-0000-0000-2000-000000000206', '00000000-0000-0000-1000-000000000002', 'VA Appraisal Complete', NOW() + INTERVAL '3 days', 'pending', 'Scheduled for this week'),
  ('00000000-0000-0000-2000-000000000207', '00000000-0000-0000-1000-000000000002', 'Clear to Close', NOW() + INTERVAL '14 days', 'pending', NULL),
  ('00000000-0000-0000-2000-000000000208', '00000000-0000-0000-1000-000000000002', 'Closing Day', NOW() + INTERVAL '21 days', 'pending', 'Before PCS date')
ON CONFLICT (id) DO NOTHING;

INSERT INTO showing_requests (id, contact_id, property_id, property_address, confirmed_date, status, client_notes)
VALUES 
  ('00000000-0000-0000-3000-000000000201', '00000000-0000-0000-0000-000000000002', 'mil-001', '456 Base Housing Rd', NOW() - INTERVAL '21 days', 'completed', 'Loved the layout, close to base'),
  ('00000000-0000-0000-3000-000000000202', '00000000-0000-0000-0000-000000000002', 'mil-002', '789 Military Way', NOW() - INTERVAL '20 days', 'completed', 'Too far from commissary'),
  ('00000000-0000-0000-3000-000000000203', '00000000-0000-0000-0000-000000000002', 'mil-003', '123 Veterans Blvd', NOW() - INTERVAL '19 days', 'completed', 'Nice but over BAH')
ON CONFLICT (id) DO NOTHING;

-- Divorce Client Demo Data (00000000-0000-0000-0000-000000000006)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000006',
  'Thompson Family Home Sale',
  '00000000-0000-0000-0000-000000000006',
  '789 Family Home Dr, Austin, TX 78701',
  'active',
  'seller',
  NOW() - INTERVAL '21 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000601', '00000000-0000-0000-1000-000000000006', 'Initial Consultation', NOW() - INTERVAL '30 days', 'completed', 'Both parties agreed to sell'),
  ('00000000-0000-0000-2000-000000000602', '00000000-0000-0000-1000-000000000006', 'Legal Review', NOW() - INTERVAL '25 days', 'completed', 'Attorney approved listing'),
  ('00000000-0000-0000-2000-000000000603', '00000000-0000-0000-1000-000000000006', 'Property Prepared', NOW() - INTERVAL '21 days', 'completed', 'Staging and photos complete'),
  ('00000000-0000-0000-2000-000000000604', '00000000-0000-0000-1000-000000000006', 'Listed on Market', NOW() - INTERVAL '14 days', 'completed', 'Live on MLS'),
  ('00000000-0000-0000-2000-000000000605', '00000000-0000-0000-1000-000000000006', 'First Showing', NOW() - INTERVAL '12 days', 'completed', '3 showings first week'),
  ('00000000-0000-0000-2000-000000000606', '00000000-0000-0000-1000-000000000006', 'Receive Offer', NOW() + INTERVAL '7 days', 'pending', 'Expecting offers soon'),
  ('00000000-0000-0000-2000-000000000607', '00000000-0000-0000-1000-000000000006', 'Equity Split Finalized', NOW() + INTERVAL '30 days', 'pending', 'Per divorce agreement')
ON CONFLICT (id) DO NOTHING;

INSERT INTO client_portal_messages (id, contact_id, message_type, title, content, is_read, created_at)
VALUES 
  ('00000000-0000-0000-4000-000000000601', '00000000-0000-0000-0000-000000000006', 'update', 'Showing Scheduled', 'A showing has been scheduled for Saturday at 2pm. Both parties will be notified separately.', true, NOW() - INTERVAL '3 days'),
  ('00000000-0000-0000-4000-000000000602', '00000000-0000-0000-0000-000000000006', 'document', 'Listing Agreement Ready', 'The listing agreement is ready for both signatures. Please review at your convenience.', false, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Senior/Downsizing Demo Data (00000000-0000-0000-0000-000000000008)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000008',
  'Anderson Family Home - 35 Year Legacy',
  '00000000-0000-0000-0000-000000000008',
  '321 Memory Lane, Sun City, AZ 85351',
  'lead',
  'seller',
  NOW() - INTERVAL '7 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000801', '00000000-0000-0000-1000-000000000008', 'Initial Home Visit', NOW() - INTERVAL '14 days', 'completed', 'Reviewed 35 years of memories together'),
  ('00000000-0000-0000-2000-000000000802', '00000000-0000-0000-1000-000000000008', 'Memory Video Recording', NOW() - INTERVAL '7 days', 'completed', 'Beautiful video of home and stories'),
  ('00000000-0000-0000-2000-000000000803', '00000000-0000-0000-1000-000000000008', 'Decluttering Support', NOW(), 'pending', 'Senior move manager coordinating'),
  ('00000000-0000-0000-2000-000000000804', '00000000-0000-0000-1000-000000000008', 'Estate Sale Planning', NOW() + INTERVAL '14 days', 'pending', 'Items identified for sale'),
  ('00000000-0000-0000-2000-000000000805', '00000000-0000-0000-1000-000000000008', 'Family Meeting', NOW() + INTERVAL '21 days', 'pending', 'Review timeline with children'),
  ('00000000-0000-0000-2000-000000000806', '00000000-0000-0000-1000-000000000008', 'Home Preparation', NOW() + INTERVAL '30 days', 'pending', 'Light updates as needed'),
  ('00000000-0000-0000-2000-000000000807', '00000000-0000-0000-1000-000000000008', 'List Property', NOW() + INTERVAL '45 days', 'pending', 'When ready')
ON CONFLICT (id) DO NOTHING;

INSERT INTO client_portal_messages (id, contact_id, message_type, title, content, is_read, created_at)
VALUES 
  ('00000000-0000-0000-4000-000000000801', '00000000-0000-0000-0000-000000000008', 'update', 'Memory Video Ready', 'Your memory video is complete! We captured 35 years of beautiful moments. Click to view and share with family.', false, NOW() - INTERVAL '2 days'),
  ('00000000-0000-0000-4000-000000000802', '00000000-0000-0000-0000-000000000008', 'resource', 'Senior Move Manager Introduction', 'Sarah from Golden Years Moving will call you tomorrow at 10am to discuss the decluttering process.', true, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Investor Demo Data (00000000-0000-0000-0000-000000000004)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000004',
  'Chen Investment Property #12',
  '00000000-0000-0000-0000-000000000004',
  '555 Investment Ave #12, Phoenix, AZ 85004',
  'under_contract',
  'buyer',
  NOW() - INTERVAL '10 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000401', '00000000-0000-0000-1000-000000000004', 'Deal Analysis', NOW() - INTERVAL '21 days', 'completed', 'Cap rate: 7.2%, CoC: 12%'),
  ('00000000-0000-0000-2000-000000000402', '00000000-0000-0000-1000-000000000004', 'Property Inspection', NOW() - INTERVAL '14 days', 'completed', 'Minor repairs needed'),
  ('00000000-0000-0000-2000-000000000403', '00000000-0000-0000-1000-000000000004', 'Offer Submitted', NOW() - INTERVAL '12 days', 'completed', '15% below asking'),
  ('00000000-0000-0000-2000-000000000404', '00000000-0000-0000-1000-000000000004', 'Under Contract', NOW() - INTERVAL '10 days', 'completed', 'Negotiated $20k credit'),
  ('00000000-0000-0000-2000-000000000405', '00000000-0000-0000-1000-000000000004', 'Investment Loan Approval', NOW() - INTERVAL '5 days', 'completed', 'DSCR loan approved'),
  ('00000000-0000-0000-2000-000000000406', '00000000-0000-0000-1000-000000000004', 'Appraisal', NOW() + INTERVAL '3 days', 'pending', 'Scheduled'),
  ('00000000-0000-0000-2000-000000000407', '00000000-0000-0000-1000-000000000004', 'Closing', NOW() + INTERVAL '20 days', 'pending', NULL),
  ('00000000-0000-0000-2000-000000000408', '00000000-0000-0000-1000-000000000004', 'Tenant Placement', NOW() + INTERVAL '35 days', 'pending', 'Property manager ready')
ON CONFLICT (id) DO NOTHING;

-- Relocating Buyer Demo Data (00000000-0000-0000-0000-000000000005)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000005',
  'Williams Relocation - Denver',
  '00000000-0000-0000-0000-000000000005',
  'TBD - Searching in Denver Metro',
  'qualifying',
  'buyer',
  NOW() - INTERVAL '5 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000501', '00000000-0000-0000-1000-000000000005', 'Relocation Consultation', NOW() - INTERVAL '14 days', 'completed', 'Reviewed company relo package'),
  ('00000000-0000-0000-2000-000000000502', '00000000-0000-0000-1000-000000000005', 'Area Orientation', NOW() - INTERVAL '7 days', 'completed', 'Virtual tour of neighborhoods'),
  ('00000000-0000-0000-2000-000000000503', '00000000-0000-0000-1000-000000000005', 'Pre-Approval', NOW() - INTERVAL '5 days', 'completed', 'Approved for $650k'),
  ('00000000-0000-0000-2000-000000000504', '00000000-0000-0000-1000-000000000005', 'Virtual Home Tours', NOW(), 'pending', '3D tours of 5 properties'),
  ('00000000-0000-0000-2000-000000000505', '00000000-0000-0000-1000-000000000005', 'In-Person Visit', NOW() + INTERVAL '7 days', 'pending', 'Flying in for weekend'),
  ('00000000-0000-0000-2000-000000000506', '00000000-0000-0000-1000-000000000005', 'Make Offer', NOW() + INTERVAL '10 days', 'pending', NULL),
  ('00000000-0000-0000-2000-000000000507', '00000000-0000-0000-1000-000000000005', 'Remote Closing', NOW() + INTERVAL '45 days', 'pending', 'RON signing available')
ON CONFLICT (id) DO NOTHING;

INSERT INTO saved_properties (id, contact_id, mls_number, property_address, list_price, beds, baths, sqft, notes, created_at)
VALUES 
  ('00000000-0000-0000-5000-000000000501', '00000000-0000-0000-0000-000000000005', 'DEN-001', '123 Mountain View Dr, Denver, CO', 575000, 4, 3, 2400, 'Top choice - great schools, 25 min commute', NOW() - INTERVAL '3 days'),
  ('00000000-0000-0000-5000-000000000502', '00000000-0000-0000-0000-000000000005', 'DEN-002', '456 Tech Park Blvd, Boulder, CO', 620000, 3, 2.5, 2100, 'Closer to office, 35 min commute', NOW() - INTERVAL '3 days'),
  ('00000000-0000-0000-5000-000000000503', '00000000-0000-0000-0000-000000000005', 'DEN-003', '789 Family Circle, Lakewood, CO', 545000, 4, 2, 2200, 'Best value, 20 min commute', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Luxury Buyer Demo Data (00000000-0000-0000-0000-000000000003)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000003',
  'Hartwell Oceanfront Estate',
  '00000000-0000-0000-0000-000000000003',
  '1 Oceanfront Estate, Malibu, CA 90265',
  'active',
  'buyer',
  NOW() - INTERVAL '7 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000301', '00000000-0000-0000-1000-000000000003', 'Private Showing', NOW() - INTERVAL '14 days', 'completed', 'Exclusive after-hours viewing'),
  ('00000000-0000-0000-2000-000000000302', '00000000-0000-0000-1000-000000000003', 'Proof of Funds Verified', NOW() - INTERVAL '10 days', 'completed', 'Cash purchase confirmed'),
  ('00000000-0000-0000-2000-000000000303', '00000000-0000-0000-1000-000000000003', 'Offer Submitted', NOW() - INTERVAL '7 days', 'completed', 'All-cash, quick close'),
  ('00000000-0000-0000-2000-000000000304', '00000000-0000-0000-1000-000000000003', 'Offer Negotiation', NOW() - INTERVAL '3 days', 'pending', 'Counter received'),
  ('00000000-0000-0000-2000-000000000305', '00000000-0000-0000-1000-000000000003', 'Due Diligence', NOW() + INTERVAL '7 days', 'pending', 'Specialist inspections'),
  ('00000000-0000-0000-2000-000000000306', '00000000-0000-0000-1000-000000000003', 'Title & Legal Review', NOW() + INTERVAL '14 days', 'pending', 'Trust/entity setup'),
  ('00000000-0000-0000-2000-000000000307', '00000000-0000-0000-1000-000000000003', 'Private Closing', NOW() + INTERVAL '21 days', 'pending', 'At attorney office')
ON CONFLICT (id) DO NOTHING;

-- FSBO Conversion Demo Data (00000000-0000-0000-0000-000000000011)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000011',
  'Baker FSBO Conversion',
  '00000000-0000-0000-0000-000000000011',
  '999 DIY Street, Portland, OR 97201',
  'lead',
  'seller',
  NOW() - INTERVAL '3 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000001101', '00000000-0000-0000-1000-000000000011', 'FSBO Analysis', NOW() - INTERVAL '7 days', 'completed', 'Reviewed 45 days on market'),
  ('00000000-0000-0000-2000-000000001102', '00000000-0000-0000-1000-000000000011', 'Market Analysis', NOW() - INTERVAL '3 days', 'completed', 'CMA shows 8% underpriced'),
  ('00000000-0000-0000-2000-000000001103', '00000000-0000-0000-1000-000000000011', 'Strategy Consultation', NOW(), 'pending', 'Discussing professional marketing'),
  ('00000000-0000-0000-2000-000000001104', '00000000-0000-0000-1000-000000000011', 'Listing Agreement', NOW() + INTERVAL '3 days', 'pending', 'If choosing to list'),
  ('00000000-0000-0000-2000-000000001105', '00000000-0000-0000-1000-000000000011', 'Professional Photos', NOW() + INTERVAL '7 days', 'pending', NULL),
  ('00000000-0000-0000-2000-000000001106', '00000000-0000-0000-1000-000000000011', 'MLS Launch', NOW() + INTERVAL '10 days', 'pending', 'Full exposure')
ON CONFLICT (id) DO NOTHING;

-- Expired Listing Demo Data (00000000-0000-0000-0000-000000000012)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000012',
  'Davis Property Relaunch',
  '00000000-0000-0000-0000-000000000012',
  '888 Second Chance Ave, Seattle, WA 98101',
  'qualifying',
  'seller',
  NOW() - INTERVAL '5 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000001201', '00000000-0000-0000-1000-000000000012', 'Expired Analysis', NOW() - INTERVAL '10 days', 'completed', 'Why it didnt sell - pricing/photos'),
  ('00000000-0000-0000-2000-000000001202', '00000000-0000-0000-1000-000000000012', 'New Strategy Meeting', NOW() - INTERVAL '5 days', 'completed', 'Fresh approach plan'),
  ('00000000-0000-0000-2000-000000001203', '00000000-0000-0000-1000-000000000012', 'Professional Staging', NOW() - INTERVAL '2 days', 'completed', 'Virtual staging complete'),
  ('00000000-0000-0000-2000-000000001204', '00000000-0000-0000-1000-000000000012', 'New Photography', NOW(), 'pending', 'Twilight shoot scheduled'),
  ('00000000-0000-0000-2000-000000001205', '00000000-0000-0000-1000-000000000012', 'Price Adjustment', NOW() + INTERVAL '2 days', 'pending', 'Strategic repositioning'),
  ('00000000-0000-0000-2000-000000001206', '00000000-0000-0000-1000-000000000012', 'Relaunch', NOW() + INTERVAL '5 days', 'pending', 'Coming Soon campaign'),
  ('00000000-0000-0000-2000-000000001207', '00000000-0000-0000-1000-000000000012', 'Active Marketing', NOW() + INTERVAL '7 days', 'pending', 'Full MLS exposure')
ON CONFLICT (id) DO NOTHING;

-- Probate Demo Data (00000000-0000-0000-0000-000000000007)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000007',
  'Martinez Estate - Probate Sale',
  '00000000-0000-0000-0000-000000000007',
  '456 Heritage Home, Sacramento, CA 95814',
  'lead',
  'seller',
  NOW() - INTERVAL '30 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000000701', '00000000-0000-0000-1000-000000000007', 'Initial Consultation', NOW() - INTERVAL '45 days', 'completed', 'Condolences and estate overview'),
  ('00000000-0000-0000-2000-000000000702', '00000000-0000-0000-1000-000000000007', 'Probate Attorney Coordination', NOW() - INTERVAL '30 days', 'completed', 'Connected with probate specialist'),
  ('00000000-0000-0000-2000-000000000703', '00000000-0000-0000-1000-000000000007', 'Court Filing', NOW() - INTERVAL '21 days', 'completed', 'Petition filed'),
  ('00000000-0000-0000-2000-000000000704', '00000000-0000-0000-1000-000000000007', 'Property Secured', NOW() - INTERVAL '14 days', 'completed', 'Locks changed, utilities managed'),
  ('00000000-0000-0000-2000-000000000705', '00000000-0000-0000-1000-000000000007', 'Court Approval Pending', NOW(), 'pending', 'Waiting on letters testamentary'),
  ('00000000-0000-0000-2000-000000000706', '00000000-0000-0000-1000-000000000007', 'Property Valuation', NOW() + INTERVAL '14 days', 'pending', 'Appraisal for court'),
  ('00000000-0000-0000-2000-000000000707', '00000000-0000-0000-1000-000000000007', 'List Property', NOW() + INTERVAL '30 days', 'pending', 'After court approval'),
  ('00000000-0000-0000-2000-000000000708', '00000000-0000-0000-1000-000000000007', 'Court Confirmation', NOW() + INTERVAL '60 days', 'pending', 'If required by state')
ON CONFLICT (id) DO NOTHING;

INSERT INTO client_portal_messages (id, contact_id, message_type, title, content, is_read, created_at)
VALUES 
  ('00000000-0000-0000-4000-000000000701', '00000000-0000-0000-0000-000000000007', 'resource', 'Probate Timeline Guide', 'I have attached a guide to help you understand the probate process timeline. Please take your time reviewing it.', true, NOW() - INTERVAL '30 days'),
  ('00000000-0000-0000-4000-000000000702', '00000000-0000-0000-0000-000000000007', 'update', 'Property Security Complete', 'The property has been secured. New locks installed and utilities transferred. Take your time with any personal items.', true, NOW() - INTERVAL '14 days')
ON CONFLICT (id) DO NOTHING;

-- Empty Nester Demo Data (00000000-0000-0000-0000-000000000013)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000013',
  'Peterson Downsizing Journey',
  '00000000-0000-0000-0000-000000000013',
  '777 Family Estate, Scottsdale, AZ 85250',
  'qualifying',
  'seller',
  NOW() - INTERVAL '10 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000001301', '00000000-0000-0000-1000-000000000013', 'Lifestyle Consultation', NOW() - INTERVAL '14 days', 'completed', 'Discussed next chapter goals'),
  ('00000000-0000-0000-2000-000000001302', '00000000-0000-0000-1000-000000000013', 'Current Home Valuation', NOW() - INTERVAL '10 days', 'completed', 'CMA completed - strong equity'),
  ('00000000-0000-0000-2000-000000001303', '00000000-0000-0000-1000-000000000013', 'New Home Search', NOW() - INTERVAL '5 days', 'pending', 'Looking at 55+ communities'),
  ('00000000-0000-0000-2000-000000001304', '00000000-0000-0000-1000-000000000013', 'Coordination Plan', NOW(), 'pending', 'Timing sell vs buy'),
  ('00000000-0000-0000-2000-000000001305', '00000000-0000-0000-1000-000000000013', 'List Current Home', NOW() + INTERVAL '30 days', 'pending', 'After finding new home'),
  ('00000000-0000-0000-2000-000000001306', '00000000-0000-0000-1000-000000000013', 'Coordinate Closings', NOW() + INTERVAL '60 days', 'pending', 'Same day if possible')
ON CONFLICT (id) DO NOTHING;

-- Upsizer/Growing Family Demo Data (00000000-0000-0000-0000-000000000014)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000014',
  'Garcia Family Upgrade',
  '00000000-0000-0000-0000-000000000014',
  'TBD - Searching in Good School Districts',
  'active',
  'buyer',
  NOW() - INTERVAL '14 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000001401', '00000000-0000-0000-1000-000000000014', 'Space Needs Assessment', NOW() - INTERVAL '21 days', 'completed', '4 bed minimum, playroom, yard'),
  ('00000000-0000-0000-2000-000000001402', '00000000-0000-0000-1000-000000000014', 'School District Research', NOW() - INTERVAL '14 days', 'completed', 'Top 3 districts identified'),
  ('00000000-0000-0000-2000-000000001403', '00000000-0000-0000-1000-000000000014', 'Pre-Approval', NOW() - INTERVAL '10 days', 'completed', 'Approved up to $750k'),
  ('00000000-0000-0000-2000-000000001404', '00000000-0000-0000-1000-000000000014', 'Home Tours', NOW() - INTERVAL '7 days', 'pending', 'Seen 6 homes so far'),
  ('00000000-0000-0000-2000-000000001405', '00000000-0000-0000-1000-000000000014', 'Current Home Valuation', NOW(), 'pending', 'CMA in progress'),
  ('00000000-0000-0000-2000-000000001406', '00000000-0000-0000-1000-000000000014', 'Make Offer on New Home', NOW() + INTERVAL '14 days', 'pending', NULL),
  ('00000000-0000-0000-2000-000000001407', '00000000-0000-0000-1000-000000000014', 'List Current Home', NOW() + INTERVAL '21 days', 'pending', 'After accepted offer'),
  ('00000000-0000-0000-2000-000000001408', '00000000-0000-0000-1000-000000000014', 'Move Before School', NOW() + INTERVAL '60 days', 'pending', 'Target: before fall semester')
ON CONFLICT (id) DO NOTHING;

INSERT INTO saved_properties (id, contact_id, mls_number, property_address, list_price, beds, baths, sqft, notes, created_at)
VALUES 
  ('00000000-0000-0000-5000-000000001401', '00000000-0000-0000-0000-000000000014', 'AUS-001', '123 Family Way, Best Schools District', 699000, 5, 3, 3200, 'Top choice! Great backyard', NOW() - INTERVAL '5 days'),
  ('00000000-0000-0000-5000-000000001402', '00000000-0000-0000-0000-000000000014', 'AUS-002', '456 Kids Lane, Family Neighborhood', 725000, 4, 3.5, 3000, 'Love the playroom', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- Repeat Buyer Demo Data (00000000-0000-0000-0000-000000000015)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000015',
  'Nguyen Return Client - New Home',
  '00000000-0000-0000-0000-000000000015',
  '555 Upgrade Blvd, Austin, TX 78701',
  'under_contract',
  'buyer',
  NOW() - INTERVAL '7 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000001501', '00000000-0000-0000-1000-000000000015', 'Reconnection Call', NOW() - INTERVAL '30 days', 'completed', 'Great to work together again!'),
  ('00000000-0000-0000-2000-000000001502', '00000000-0000-0000-1000-000000000015', 'Updated Pre-Approval', NOW() - INTERVAL '21 days', 'completed', 'Stronger position this time'),
  ('00000000-0000-0000-2000-000000001503', '00000000-0000-0000-1000-000000000015', 'Found The One', NOW() - INTERVAL '10 days', 'completed', 'Knew it immediately'),
  ('00000000-0000-0000-2000-000000001504', '00000000-0000-0000-1000-000000000015', 'Under Contract', NOW() - INTERVAL '7 days', 'completed', 'Smooth as last time'),
  ('00000000-0000-0000-2000-000000001505', '00000000-0000-0000-1000-000000000015', 'Inspection', NOW() - INTERVAL '3 days', 'completed', 'Clean report'),
  ('00000000-0000-0000-2000-000000001506', '00000000-0000-0000-1000-000000000015', 'Appraisal', NOW() + INTERVAL '5 days', 'pending', 'Scheduled'),
  ('00000000-0000-0000-2000-000000001507', '00000000-0000-0000-1000-000000000015', 'Closing', NOW() + INTERVAL '21 days', 'pending', 'Same title company')
ON CONFLICT (id) DO NOTHING;

-- Land/Lot Buyer Demo Data (00000000-0000-0000-0000-000000000016)
INSERT INTO transactions (id, deal_name, contact_id, property_address, status, transaction_type, created_at)
VALUES (
  '00000000-0000-0000-1000-000000000016',
  'Turner Custom Build Lot',
  '00000000-0000-0000-0000-000000000016',
  'Lot 42, Mountain View Estates',
  'active',
  'buyer',
  NOW() - INTERVAL '21 days'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_milestones (id, transaction_id, milestone_name, milestone_date, status, notes)
VALUES 
  ('00000000-0000-0000-2000-000000001601', '00000000-0000-0000-1000-000000000016', 'Land Search Started', NOW() - INTERVAL '45 days', 'completed', 'Min 2 acres, mountain views'),
  ('00000000-0000-0000-2000-000000001602', '00000000-0000-0000-1000-000000000016', 'Builder Consultations', NOW() - INTERVAL '30 days', 'completed', 'Selected preferred builder'),
  ('00000000-0000-0000-2000-000000001603', '00000000-0000-0000-1000-000000000016', 'Lot Identified', NOW() - INTERVAL '21 days', 'completed', '3.5 acres, perfect views'),
  ('00000000-0000-0000-2000-000000001604', '00000000-0000-0000-1000-000000000016', 'Perc Test & Survey', NOW() - INTERVAL '14 days', 'completed', 'Passed - septic approved'),
  ('00000000-0000-0000-2000-000000001605', '00000000-0000-0000-1000-000000000016', 'Offer Submitted', NOW() - INTERVAL '10 days', 'completed', 'Land contract terms'),
  ('00000000-0000-0000-2000-000000001606', '00000000-0000-0000-1000-000000000016', 'Due Diligence', NOW(), 'pending', 'Zoning, utilities, access'),
  ('00000000-0000-0000-2000-000000001607', '00000000-0000-0000-1000-000000000016', 'Construction Loan', NOW() + INTERVAL '14 days', 'pending', 'Working with lender'),
  ('00000000-0000-0000-2000-000000001608', '00000000-0000-0000-1000-000000000016', 'Land Closing', NOW() + INTERVAL '30 days', 'pending', NULL)
ON CONFLICT (id) DO NOTHING;
