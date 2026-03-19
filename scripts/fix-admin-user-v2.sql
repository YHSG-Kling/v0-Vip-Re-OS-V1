-- Fix admin user brokerage association
-- This script updates existing records only (no inserts to avoid FK issues)

-- First, get the brokerage ID
DO $$
DECLARE
  v_brokerage_id uuid;
  v_user_id uuid;
BEGIN
  -- Get the first brokerage
  SELECT id INTO v_brokerage_id FROM public.brokerages LIMIT 1;
  
  IF v_brokerage_id IS NULL THEN
    RAISE NOTICE 'No brokerage found - please create one first';
    RETURN;
  END IF;
  
  RAISE NOTICE 'Found brokerage: %', v_brokerage_id;
  
  -- Get the admin user ID from public.users
  SELECT id INTO v_user_id FROM public.users WHERE email = 'admin@yourbrokerage.com';
  
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'No user found with email admin@yourbrokerage.com';
    RETURN;
  END IF;
  
  RAISE NOTICE 'Found user: %', v_user_id;
  
  -- Update the user's brokerage_id and user_type in public.users
  UPDATE public.users 
  SET brokerage_id = v_brokerage_id,
      user_type = 'admin'
  WHERE id = v_user_id;
  
  RAISE NOTICE 'Updated public.users record';
  
  -- Update user_role_assignments if a record exists
  UPDATE public.user_role_assignments
  SET brokerage_id = v_brokerage_id,
      role = 'admin'
  WHERE user_id = v_user_id;
  
  RAISE NOTICE 'Updated user_role_assignments record (if exists)';
  
  -- If no role assignment exists, we need to insert one
  -- First check if user_id exists in auth.users (the FK constraint target)
  IF NOT EXISTS (SELECT 1 FROM public.user_role_assignments WHERE user_id = v_user_id) THEN
    -- Try to insert, but handle the FK constraint gracefully
    BEGIN
      INSERT INTO public.user_role_assignments (user_id, role, brokerage_id)
      VALUES (v_user_id, 'admin', v_brokerage_id)
      ON CONFLICT (user_id, role) DO UPDATE SET brokerage_id = EXCLUDED.brokerage_id;
      RAISE NOTICE 'Inserted new user_role_assignments record';
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'Could not insert role assignment - FK constraint. User may need to be synced from auth.users';
    END;
  END IF;
  
END $$;

-- Verify the fix
SELECT 
  u.id,
  u.email,
  u.user_type,
  u.brokerage_id,
  ura.role as role_assignment,
  ura.brokerage_id as role_brokerage_id
FROM public.users u
LEFT JOIN public.user_role_assignments ura ON u.id = ura.user_id
WHERE u.email = 'admin@yourbrokerage.com';
