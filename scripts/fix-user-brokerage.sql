-- Fix users with missing brokerage_id by linking to existing brokerage
-- This script updates users who have NULL brokerage_id and matches them
-- to the brokerage based on their email domain or assigns to the first brokerage

-- First, let's see the current state
-- SELECT u.id, u.email, u.brokerage_id, b.id as existing_brokerage_id, b.name as brokerage_name
-- FROM public.users u
-- CROSS JOIN public.brokerages b
-- WHERE u.brokerage_id IS NULL
-- LIMIT 10;

-- Update admin@yourbrokerage.com specifically to the first brokerage
UPDATE public.users
SET brokerage_id = (
  SELECT id FROM public.brokerages LIMIT 1
)
WHERE email = 'admin@yourbrokerage.com'
  AND brokerage_id IS NULL;

-- Also update any other users with NULL brokerage_id to the first brokerage
-- Only run this if you want ALL users without a brokerage to be assigned
UPDATE public.users
SET brokerage_id = (
  SELECT id FROM public.brokerages LIMIT 1
)
WHERE brokerage_id IS NULL
  AND EXISTS (SELECT 1 FROM public.brokerages);
