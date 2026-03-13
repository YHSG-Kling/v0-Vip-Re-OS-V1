-- Fix admin user brokerage association - comprehensive script
-- This script ensures admin@yourbrokerage.com has proper brokerage_id in all tables

-- Get the admin user ID and first brokerage ID
DO $$
DECLARE
  v_user_id uuid;
  v_brokerage_id uuid;
  v_row_count integer;
BEGIN
  -- Get admin user ID from auth.users
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'admin@yourbrokerage.com';
  
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'Admin user not found in auth.users';
    RETURN;
  END IF;
  
  RAISE NOTICE 'Found admin user ID: %', v_user_id;
  
  -- Get first brokerage ID
  SELECT id INTO v_brokerage_id FROM public.brokerages ORDER BY created_at LIMIT 1;
  
  IF v_brokerage_id IS NULL THEN
    -- Create a default brokerage if none exists
    INSERT INTO public.brokerages (name, slug, status)
    VALUES ('Your Brokerage', 'your-brokerage', 'active')
    RETURNING id INTO v_brokerage_id;
    RAISE NOTICE 'Created new brokerage with ID: %', v_brokerage_id;
  ELSE
    RAISE NOTICE 'Found brokerage ID: %', v_brokerage_id;
  END IF;
  
  -- Update public.users
  UPDATE public.users
  SET brokerage_id = v_brokerage_id,
      user_type = 'admin'
  WHERE id = v_user_id;
  
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RAISE NOTICE 'Updated public.users - rows affected: %', v_row_count;
  
  -- Update user_role_assignments
  UPDATE public.user_role_assignments
  SET brokerage_id = v_brokerage_id,
      role = 'admin'
  WHERE user_id = v_user_id;
  
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RAISE NOTICE 'Updated user_role_assignments - rows affected: %', v_row_count;
  
  -- If no role assignment exists, create one
  IF v_row_count = 0 THEN
    INSERT INTO public.user_role_assignments (user_id, role, brokerage_id)
    VALUES (v_user_id, 'admin', v_brokerage_id)
    ON CONFLICT (user_id, role) DO UPDATE SET brokerage_id = v_brokerage_id;
    RAISE NOTICE 'Inserted new role assignment';
  END IF;
  
  RAISE NOTICE 'Admin user fix completed successfully';
  
END $$;

-- Verify the changes
SELECT 'AFTER - public.users' as source, id, email, user_type, brokerage_id
FROM public.users WHERE email = 'admin@yourbrokerage.com';

SELECT 'AFTER - user_role_assignments' as source, user_id, role, brokerage_id
FROM public.user_role_assignments 
WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'admin@yourbrokerage.com');
