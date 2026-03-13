-- Fix admin user completely: ensure brokerage_id is set everywhere

-- First, get the brokerage ID
DO $$
DECLARE
  v_brokerage_id UUID;
  v_user_id UUID;
BEGIN
  -- Get the first brokerage
  SELECT id INTO v_brokerage_id FROM public.brokerages LIMIT 1;
  
  -- Get the admin user ID
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'admin@yourbrokerage.com';
  
  IF v_brokerage_id IS NULL THEN
    RAISE NOTICE 'No brokerage found - creating one';
    INSERT INTO public.brokerages (id, name, slug)
    VALUES (gen_random_uuid(), 'Your Brokerage', 'your-brokerage')
    RETURNING id INTO v_brokerage_id;
  END IF;
  
  IF v_user_id IS NOT NULL THEN
    -- Update public.users with brokerage_id
    UPDATE public.users 
    SET brokerage_id = v_brokerage_id, 
        user_type = 'admin'
    WHERE id = v_user_id;
    
    RAISE NOTICE 'Updated public.users for % with brokerage_id %', v_user_id, v_brokerage_id;
    
    -- Update or insert user_role_assignments
    INSERT INTO public.user_role_assignments (user_id, role, brokerage_id)
    VALUES (v_user_id, 'admin', v_brokerage_id)
    ON CONFLICT (user_id, role) 
    DO UPDATE SET brokerage_id = v_brokerage_id;
    
    RAISE NOTICE 'Updated user_role_assignments for %', v_user_id;
  ELSE
    RAISE NOTICE 'Admin user not found in auth.users';
  END IF;
END $$;

-- Verify the fix
SELECT 
  u.id,
  u.email,
  u.user_type,
  u.brokerage_id as users_brokerage_id,
  ura.role,
  ura.brokerage_id as role_brokerage_id
FROM public.users u
LEFT JOIN public.user_role_assignments ura ON u.id = ura.user_id
WHERE u.email = 'admin@yourbrokerage.com';
