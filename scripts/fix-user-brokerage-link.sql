-- Fix users table to ensure brokerage_id is properly set
-- This links existing users to the first brokerage if they don't have one set

-- First, verify we have at least one brokerage
DO $$
DECLARE
  first_brokerage_id uuid;
  updated_count integer;
BEGIN
  -- Get the first brokerage
  SELECT id INTO first_brokerage_id FROM public.brokerages ORDER BY created_at ASC LIMIT 1;
  
  IF first_brokerage_id IS NULL THEN
    RAISE NOTICE 'No brokerages found. Cannot link users.';
    RETURN;
  END IF;
  
  -- Update users without brokerage_id
  UPDATE public.users 
  SET brokerage_id = first_brokerage_id, updated_at = now()
  WHERE brokerage_id IS NULL;
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Updated % users with brokerage_id: %', updated_count, first_brokerage_id;
  
  -- Also update user_role_assignments without brokerage_id
  UPDATE public.user_role_assignments
  SET brokerage_id = first_brokerage_id, updated_at = now()
  WHERE brokerage_id IS NULL;
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Updated % role assignments with brokerage_id: %', updated_count, first_brokerage_id;
END $$;

-- Show current state
SELECT 
  u.email, 
  u.user_type, 
  u.brokerage_id,
  b.name as brokerage_name
FROM public.users u
LEFT JOIN public.brokerages b ON b.id = u.brokerage_id
ORDER BY u.created_at DESC
LIMIT 10;
