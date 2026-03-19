-- Check if the auth.users ID matches public.users ID for admin@yourbrokerage.com

-- 1. Get the auth.users entry for admin@yourbrokerage.com
SELECT 
  id as auth_user_id,
  email,
  raw_user_meta_data->>'user_type' as auth_user_type
FROM auth.users 
WHERE email = 'admin@yourbrokerage.com';

-- 2. Get the public.users entry for admin@yourbrokerage.com
SELECT 
  id as public_user_id,
  email,
  user_type,
  brokerage_id
FROM public.users 
WHERE email = 'admin@yourbrokerage.com';

-- 3. Check if the IDs match - this is likely the issue!
SELECT 
  a.id as auth_id,
  a.email,
  p.id as public_user_id,
  CASE WHEN a.id = p.id THEN 'MATCH' ELSE 'MISMATCH - THIS IS THE PROBLEM!' END as id_status
FROM auth.users a
LEFT JOIN public.users p ON p.email = a.email
WHERE a.email = 'admin@yourbrokerage.com';

-- 4. Also check the user_role_assignments for both IDs
SELECT 
  user_id,
  role,
  brokerage_id
FROM public.user_role_assignments
WHERE user_id IN (
  SELECT id FROM auth.users WHERE email = 'admin@yourbrokerage.com'
  UNION
  SELECT id FROM public.users WHERE email = 'admin@yourbrokerage.com'
);
