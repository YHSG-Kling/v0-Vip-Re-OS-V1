-- Check the admin user's current data
SELECT 
  id,
  email,
  user_type,
  brokerage_id
FROM public.users 
WHERE email = 'admin@yourbrokerage.com';

-- Check role assignments for the admin user
SELECT 
  ura.user_id,
  ura.role,
  ura.brokerage_id,
  u.email
FROM public.user_role_assignments ura
JOIN public.users u ON u.id = ura.user_id
WHERE u.email = 'admin@yourbrokerage.com';

-- Fix: Update the user_type to 'admin' for the admin user
UPDATE public.users 
SET user_type = 'admin'
WHERE email = 'admin@yourbrokerage.com';

-- Fix: Ensure role assignment exists with 'admin' role
INSERT INTO public.user_role_assignments (user_id, role, brokerage_id)
SELECT 
  u.id,
  'admin',
  u.brokerage_id
FROM public.users u
WHERE u.email = 'admin@yourbrokerage.com'
ON CONFLICT (user_id, role) DO UPDATE SET role = 'admin';

-- Verify the fix
SELECT 
  u.id,
  u.email,
  u.user_type,
  ura.role as role_assignment
FROM public.users u
LEFT JOIN public.user_role_assignments ura ON ura.user_id = u.id
WHERE u.email = 'admin@yourbrokerage.com';
