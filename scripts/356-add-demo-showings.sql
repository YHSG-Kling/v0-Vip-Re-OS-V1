-- Add demo showings for first-time buyer persona
-- This ensures the showings page has data to display

INSERT INTO showing_requests (
  contact_id,
  property_id,
  property_address,
  property_data,
  preferred_dates,
  confirmed_date,
  status,
  client_notes,
  created_at
) VALUES 
(
  '00000000-0000-0000-0000-000000000001',
  'demo-prop-1',
  '123 Oak Lane, Austin, TX 78701',
  '{"beds": 3, "baths": 2, "sqft": 1850, "price": 425000}'::jsonb,
  '["2026-01-20T14:00:00Z", "2026-01-21T10:00:00Z"]'::jsonb,
  '2026-01-20 14:00:00+00',
  'confirmed',
  'Very excited to see this one!',
  now()
),
(
  '00000000-0000-0000-0000-000000000001',
  'demo-prop-2', 
  '456 Maple Drive, Austin, TX 78702',
  '{"beds": 4, "baths": 2.5, "sqft": 2200, "price": 475000}'::jsonb,
  '["2026-01-22T11:00:00Z"]'::jsonb,
  '2026-01-22 11:00:00+00',
  'confirmed',
  'Love the backyard in the photos',
  now()
),
(
  '00000000-0000-0000-0000-000000000001',
  'demo-prop-3',
  '789 Pine Street, Austin, TX 78703',
  '{"beds": 3, "baths": 2, "sqft": 1650, "price": 385000}'::jsonb,
  '["2026-01-25T15:00:00Z", "2026-01-26T09:00:00Z"]'::jsonb,
  NULL,
  'pending',
  'Interested in the school district',
  now()
),
(
  '00000000-0000-0000-0000-000000000001',
  'demo-prop-4',
  '321 Elm Avenue, Austin, TX 78704',
  '{"beds": 3, "baths": 2, "sqft": 1750, "price": 399000}'::jsonb,
  '["2026-01-10T13:00:00Z"]'::jsonb,
  '2026-01-10 13:00:00+00',
  'completed',
  NULL,
  now() - interval '7 days'
),
(
  '00000000-0000-0000-0000-000000000001',
  'demo-prop-5',
  '555 Cedar Court, Austin, TX 78705',
  '{"beds": 4, "baths": 3, "sqft": 2400, "price": 525000}'::jsonb,
  '["2026-01-08T10:00:00Z"]'::jsonb,
  '2026-01-08 10:00:00+00',
  'completed',
  NULL,
  now() - interval '10 days'
)
ON CONFLICT DO NOTHING;

-- Add feedback for completed showings
UPDATE showing_requests 
SET 
  feedback_rating = 4,
  feedback_notes = 'Great layout, loved the kitchen. A bit concerned about the small backyard.',
  interested_level = 'interested'
WHERE property_address = '321 Elm Avenue, Austin, TX 78704' 
  AND contact_id = '00000000-0000-0000-0000-000000000001';

UPDATE showing_requests 
SET 
  feedback_rating = 5,
  feedback_notes = 'Perfect! This is my top choice. Love everything about it.',
  interested_level = 'very_interested'
WHERE property_address = '555 Cedar Court, Austin, TX 78705' 
  AND contact_id = '00000000-0000-0000-0000-000000000001';
